import * as THREE from 'three';

export class TerrainDatabase {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainModified = false;
        this.saveTimeout = null;
        this.lastSaveTime = 0;
        this.SAVE_THROTTLE = 2000;
        this.terrainData = null;
        this.allTerrainChanges = {}; // Track both by ID and username
        this.myUsername = '';
        this.statusElement = document.getElementById('save-status');
        this.strokeStartTime = null;
    }

    async initialize() {
        this.myUsername = this.room.peers[this.room.clientId].username;
        await this.loadTerrainData();
    }

    // Load terrain data from database
    async loadTerrainData() {
        try {
            // First try to get the latest terrain snapshot
            const snapshots = await this.room.collection('terrainSnapshot').getList();
            let baseHeightData = null;
            let snapshotTime = null;
            
            // Find the most recent snapshot
            if (snapshots.length > 0) {
                const latestSnapshot = snapshots.sort((a, b) => 
                    new Date(b.created_at) - new Date(a.created_at)
                )[0];
                
                console.log('Found terrain snapshot from:', new Date(latestSnapshot.created_at));
                baseHeightData = latestSnapshot.heightData;
                snapshotTime = new Date(latestSnapshot.created_at);
                
                // Apply the snapshot as base terrain
                this.applyHeightDataToTerrain(baseHeightData);
            }
            
            // Get all incremental changes after the snapshot
            const changes = await this.room.collection('terrainChange').getList();
            let changesAfterSnapshot = changes;
            if (snapshotTime) {
                // Get all changes after the snapshot timestamp
                changesAfterSnapshot = changes.filter(change => 
                    new Date(change.created_at) > snapshotTime
                );
            }
                
            if (changesAfterSnapshot.length > 0) {
                console.log(`Applying ${changesAfterSnapshot.length} changes after snapshot`);
                // Sort changes chronologically before applying
                changesAfterSnapshot.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                this.applyIncrementalChanges(changesAfterSnapshot);
            }
            
            // If no data exists, create a flat terrain as the first snapshot
            if (!baseHeightData && changesAfterSnapshot.length === 0) {
                console.log('No existing terrain data, creating flat terrain snapshot');
                await this.createFlatTerrainSnapshot();
            }
            
            // Store all change IDs we've applied
            changes.forEach(change => {
                this.allTerrainChanges[change.id] = true;
            });
            
            // Subscribe to future terrain changes
            this.room.collection('terrainChange').subscribe((changes) => {
                // Filter out changes we've already processed
                const newChanges = changes.filter(change => 
                    !this.allTerrainChanges[change.id]
                );
                
                if (newChanges.length > 0) {
                    // Sort by creation time before applying
                    newChanges.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                    this.applyIncrementalChanges(newChanges);
                    
                    // Track these changes to avoid reapplying
                    newChanges.forEach(change => {
                        this.allTerrainChanges[change.id] = true;
                    });
                }
            });
            
        } catch (error) {
            console.error('Error loading terrain data:', error);
        }
    }
    
    // Apply a full height data map to the terrain geometry
    applyHeightDataToTerrain(heightData) {
        if (!heightData || typeof heightData !== 'object') {
            console.error('Invalid height data:', heightData);
            return;
        }
        
        const positions = this.geometry.attributes.position;
        let applied = false;
        
        // Convert string keys back to integers
        for (let i = 0; i < positions.count; i++) {
            // Check both string and integer keys
            const height = heightData[i] !== undefined ? heightData[i] : heightData[String(i)];
            if (height !== undefined) {
                positions.setY(i, height);
                applied = true;
                
                // Update our cached terrain state
                if (!this.terrainData) this.terrainData = {};
                this.terrainData[i] = height;
            }
        }
        
        if (applied) {
            positions.needsUpdate = true;
            this.geometry.computeVertexNormals();
            console.log('Applied complete height data to terrain');
        } else {
            console.warn('No height data was applied to the terrain');
        }
    }
    
    // Apply a series of incremental changes
    applyIncrementalChanges(changes) {
        if (!changes || changes.length === 0) return;
        
        const positions = this.geometry.attributes.position;
        let vertexModified = false;
        
        // Process each change
        changes.forEach(change => {
            if (!change.changes) {
                console.warn('Change record has no changes property:', change);
                return;
            }
            
            // Apply the vertex changes to our terrain
            try {
                const vertexChanges = change.changes;
                
                // Apply only the modified vertices
                Object.entries(vertexChanges).forEach(([index, height]) => {
                    const intIndex = parseInt(index);
                    positions.setY(intIndex, height);
                    vertexModified = true;
                    
                    // Update our cached terrain state
                    if (!this.terrainData) this.terrainData = {};
                    this.terrainData[intIndex] = height;
                });
                
                // Track this change to avoid reapplying
                this.allTerrainChanges[change.id] = true;
            } catch (error) {
                console.error('Error applying terrain change:', error);
            }
        });
        
        if (vertexModified) {
            positions.needsUpdate = true;
            this.geometry.computeVertexNormals();
            console.log(`Applied ${changes.length} incremental changes`);
        } else {
            console.warn('No changes were applied to the terrain');
        }
    }
    
    // Save changes with timestamps for stroke begin and end
    async saveTerrainChangesWithTimestamp(geometry) {
        const strokeEndTime = new Date().toISOString();
        
        try {
            this.showSaveStatus(true);
            
            // Compare current geometry to the last saved version
            // and only save the vertices that have changed
            const positions = geometry.attributes.position;
            const changedVertices = {};
            let changeCount = 0;
            
            // Identify which vertices have changed by comparing with our last saved state
            if (this.terrainData) {
                for (let i = 0; i < positions.count; i++) {
                    const currentHeight = positions.getY(i);
                    if (this.terrainData[i] !== currentHeight) {
                        changedVertices[i] = currentHeight;
                        this.terrainData[i] = currentHeight; // Update our cached version
                        changeCount++;
                    }
                }
            } else {
                // First time - store all vertices
                this.terrainData = {};
                for (let i = 0; i < positions.count; i++) {
                    const height = positions.getY(i);
                    this.terrainData[i] = height;
                    changedVertices[i] = height;
                    changeCount++;
                }
            }
            
            // Only save if there are changes
            if (changeCount > 0) {
                console.log(`Saving ${changeCount} changed vertices`);
                
                // Use current time as stroke start if none set
                const strokeStartTime = this.strokeStartTime || new Date().toISOString();
                
                // Save just the changes (not the entire terrain) for efficiency
                await this.room.collection('terrainChange').create({
                    changes: changedVertices,
                    changeCount: changeCount,
                    strokeStartTime: strokeStartTime,
                    strokeEndTime: strokeEndTime
                });
                
                // Periodically save a full snapshot for faster loading
                // Store a count of our changes
                this.changesSinceSnapshot = (this.changesSinceSnapshot || 0) + 1;
                
                // Create a new snapshot every 10 change batches
                if (this.changesSinceSnapshot >= 10) {
                    await this.createFullTerrainSnapshot();
                    this.changesSinceSnapshot = 0;
                }
            }
            
            this.showSaveStatus(false);
            // Reset stroke start time
            this.strokeStartTime = null;
        } catch (error) {
            console.error('Error saving terrain changes:', error);
            this.showSaveStatus(false, true);
            this.strokeStartTime = null;
        }
    }
    
    // Create a snapshot of the entire terrain state
    async createFullTerrainSnapshot() {
        try {
            // Collect height data from all vertices
            const fullHeightData = {};
            const positions = this.geometry.attributes.position;
            
            for (let i = 0; i < positions.count; i++) {
                fullHeightData[i] = positions.getY(i);
            }
            
            // Save the snapshot to the database
            await this.room.collection('terrainSnapshot').create({
                heightData: fullHeightData,
                vertexCount: positions.count,
                timestamp: new Date().toISOString()
            });
            
            console.log('Created new terrain snapshot');
        } catch (error) {
            console.error('Error creating terrain snapshot:', error);
        }
    }
    
    // Create a flat terrain snapshot (initial state)
    async createFlatTerrainSnapshot() {
        try {
            // Create a flat terrain (all heights at 0)
            const positions = this.geometry.attributes.position;
            const heightData = {};
            
            for (let i = 0; i < positions.count; i++) {
                heightData[i] = 0;
                positions.setY(i, 0); // Also set the geometry to flat
            }
            
            positions.needsUpdate = true;
            this.geometry.computeVertexNormals();
            
            // Store this as our cached terrain state
            this.terrainData = heightData;
            
            // Save the snapshot to the database
            await this.room.collection('terrainSnapshot').create({
                heightData: heightData,
                vertexCount: positions.count,
                isInitial: true,
                timestamp: new Date().toISOString()
            });
            
            console.log('Created initial flat terrain snapshot');
        } catch (error) {
            console.error('Error creating flat terrain snapshot:', error);
        }
    }
    
    // Show save status indicator
    showSaveStatus(isVisible, isError = false) {
        if (!this.statusElement) return;
        
        this.statusElement.textContent = isError ? 'Error saving changes!' : 'Saving changes...';
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        
        if (isVisible && !isError) {
            setTimeout(() => {
                this.statusElement.style.opacity = '0';
            }, 1500);
        }
    }
}