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
        this.userRowId = null; // Store the user's row ID
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
            
            // Get all users' terrain changes
            const userTerrainRows = await this.room.collection('userTerrain').getList();
            
            // Debug logging of all rows and usernames
            console.log('Current user:', this.myUsername);
            console.log('All terrain rows:', userTerrainRows.map(row => ({
                id: row.id,
                username: row.username,
                changeCount: row.changeCount || 0
            })));
            
            // Find this user's row or create if it doesn't exist
            let userRow = userTerrainRows.find(row => row.username === this.myUsername);
            
            if (userRow) {
                console.log(`Found existing terrain row for user ${this.myUsername} with ID ${userRow.id}`);
                this.userRowId = userRow.id;
            } else {
                console.log(`No terrain row found for user ${this.myUsername}, creating new row`);
                userRow = await this.room.collection('userTerrain').create({
                    changes: {},
                    changeCount: 0,
                    lastModified: new Date().toISOString()
                });
                this.userRowId = userRow.id;
                console.log(`Created new terrain row with ID ${this.userRowId}`);
            }
            
            // Apply all users' changes
            userTerrainRows.forEach(row => {
                if (row.changes && Object.keys(row.changes).length > 0) {
                    console.log(`Applying ${Object.keys(row.changes).length} changes from user ${row.username}`);
                    this.applyUserChanges(row.changes);
                }
            });
            
            // Subscribe to changes in the userTerrain collection
            this.room.collection('userTerrain').subscribe((rows) => {
                // Process each user's changes
                rows.forEach(row => {
                    // Skip our own row as we manage it directly
                    if (row.id === this.userRowId) return;
                    
                    // Apply the changes from other users
                    if (row.changes) {
                        this.applyUserChanges(row.changes);
                    }
                });
            });
            
            // If no data exists, create a flat terrain as the first snapshot
            if (!baseHeightData && userTerrainRows.length === 0) {
                console.log('No existing terrain data, creating flat terrain snapshot');
                await this.createFlatTerrainSnapshot();
            }
            
        } catch (error) {
            console.error('Error loading terrain data:', error);
        }
    }
    
    // Apply a user's changes to the terrain
    applyUserChanges(changes) {
        if (!changes || Object.keys(changes).length === 0) return;
        
        const positions = this.geometry.attributes.position;
        let vertexModified = false;
        
        // Apply the vertex changes to our terrain
        try {
            // Apply only the modified vertices
            Object.entries(changes).forEach(([index, height]) => {
                const intIndex = parseInt(index);
                positions.setY(intIndex, height);
                vertexModified = true;
                
                // Update our cached terrain state
                if (!this.terrainData) this.terrainData = {};
                this.terrainData[intIndex] = height;
            });
        } catch (error) {
            console.error('Error applying terrain change:', error);
        }
        
        if (vertexModified) {
            positions.needsUpdate = true;
            this.geometry.computeVertexNormals();
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
                
                if (this.userRowId) {
                    // Get the current user row
                    let userRow = await this.room.collection('userTerrain').filter({id: this.userRowId}).getList();
                    console.log(`Looking for row with ID ${this.userRowId}`, userRow);
                    
                    if (userRow && userRow.length > 0) {
                        // Update existing row with merged changes
                        const existingChanges = userRow[0].changes || {};
                        const mergedChanges = {...existingChanges, ...changedVertices};
                        
                        console.log(`Updating terrain row ${this.userRowId} for user ${this.myUsername}`);
                        await this.room.collection('userTerrain').update(this.userRowId, {
                            changes: mergedChanges,
                            changeCount: Object.keys(mergedChanges).length,
                            lastModified: new Date().toISOString(),
                            strokeStartTime: strokeStartTime,
                            strokeEndTime: strokeEndTime
                        });
                    } else {
                        console.warn(`User row with ID ${this.userRowId} not found, creating a new one`);
                        // Get latest rows to check what's in the database
                        const allRows = await this.room.collection('userTerrain').getList();
                        console.log('Current database rows:', allRows.map(r => ({ id: r.id, username: r.username })));
                        
                        const newRow = await this.room.collection('userTerrain').create({
                            changes: changedVertices,
                            changeCount: changeCount,
                            lastModified: new Date().toISOString(),
                            strokeStartTime: strokeStartTime,
                            strokeEndTime: strokeEndTime
                        });
                        this.userRowId = newRow.id;
                        console.log(`Created new terrain row with ID ${this.userRowId}`);
                    }
                } else {
                    // Create a new row for this user
                    console.log(`No row ID stored, creating new terrain row for ${this.myUsername}`);
                    const newRow = await this.room.collection('userTerrain').create({
                        changes: changedVertices,
                        changeCount: changeCount,
                        lastModified: new Date().toISOString(),
                        strokeStartTime: strokeStartTime,
                        strokeEndTime: strokeEndTime
                    });
                    this.userRowId = newRow.id;
                    console.log(`Created new terrain row with ID ${this.userRowId}`);
                }
                
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