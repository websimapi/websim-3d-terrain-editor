import * as THREE from 'three';

export class TerrainDatabase {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainModified = false; // Flag for local modifications
        this.lastSaveTime = 0;
        this.SAVE_THROTTLE = 2000; // Not currently used, saving on stroke end
        // Represents the fully loaded/merged height state of the terrain
        this.terrainHeightData = {}; // Stores { vertexIndex: height }
        // Track processed change IDs to prevent re-applying from subscription
        this.processedChangeIds = new Set();
        this.myUsername = '';
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke
        this.currentStrokeHeightChanges = {};
        this.strokeStartTime = null;
        this.changesSinceSnapshot = 0;
        this.SNAPSHOT_THRESHOLD = 10; // Create snapshot every N change records
    }

    async initialize() {
        this.myUsername = this.room.peers[this.room.clientId].username;
        await this.loadTerrainData();
    }

    // Load terrain data from database (snapshot + incremental changes)
    async loadTerrainData() {
        try {
            console.log("Loading terrain height data...");
            const positions = this.geometry.attributes.position;

            // 1. Fetch the latest terrain height snapshot
            const snapshots = await this.room.collection('terrainSnapshot').getList();
            let latestSnapshot = null;
            let snapshotTime = null;
            if (snapshots.length > 0) {
                latestSnapshot = snapshots.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                snapshotTime = new Date(latestSnapshot.created_at);
                console.log('Applying terrain height snapshot from:', snapshotTime);
                this.applyHeightSnapshot(latestSnapshot.heightData);
                this.processedChangeIds.add(latestSnapshot.id); // Mark snapshot as processed
            } else {
                console.log("No terrain height snapshot found. Creating initial flat terrain.");
                // If no snapshot exists, initialize geometry to flat and save it
                await this.createFlatTerrainSnapshot(); // This sets geometry and saves
            }

            // 2. Fetch incremental changes made *after* the snapshot time
            const allChanges = await this.room.collection('terrainChange').getList();
            let changesToApply = allChanges;
            if (snapshotTime) {
                 console.log(`Filtering ${allChanges.length} height changes after snapshot time ${snapshotTime.toISOString()}`);
                 changesToApply = allChanges.filter(change => {
                    const changeTime = new Date(change.created_at);
                     // Also ensure we haven't processed this specific change ID already
                    return changeTime > snapshotTime && !this.processedChangeIds.has(change.id);
                 });
            } else {
                 // If no snapshot, apply all changes we haven't processed
                 changesToApply = allChanges.filter(change => !this.processedChangeIds.has(change.id));
            }


            if (changesToApply.length > 0) {
                console.log(`Found ${changesToApply.length} incremental height changes to apply.`);
                this.applyIncrementalHeightChanges(changesToApply);
            } else {
                 console.log("No new incremental height changes found after snapshot (or no snapshot).");
            }

            // 3. Subscribe to future incremental changes
            this.room.collection('terrainChange').subscribe((incomingChanges) => {
                // Filter out changes we've already processed locally or via initial load
                const newChanges = incomingChanges.filter(change => !this.processedChangeIds.has(change.id));
                if (newChanges.length > 0) {
                    console.log(`Received ${newChanges.length} new height changes via subscription.`);
                    this.applyIncrementalHeightChanges(newChanges);
                }
            });

             console.log("Terrain height data loading process complete.");

        } catch (error) {
            console.error('Error loading terrain height data:', error);
            // Fallback: ensure terrain is at least flat
            this.applyHeightSnapshot({}); // Apply empty data to ensure reset potentially
        } finally {
            // Ensure geometry is updated visually after loading attempt
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
        }
    }

    // Apply a full height data map (from a snapshot)
    applyHeightSnapshot(heightData) {
         if (!heightData || typeof heightData !== 'object') {
            console.warn('Invalid height snapshot data:', heightData);
            // Ensure terrain is reset to flat if data is bad
            heightData = {};
         }
         console.log("Applying height snapshot...");
         const positions = this.geometry.attributes.position;
         let applied = false;
         // Replace local state completely with snapshot data
         this.terrainHeightData = { ...heightData };

         // Apply heights from snapshot, default to 0 if index missing
         for (let i = 0; i < positions.count; i++) {
             const height = heightData[i] !== undefined ? heightData[String(i)] : 0; // Default to 0
             positions.setY(i, height);
             if (heightData[i] !== undefined) applied = true; // Mark if actual data was applied
             // Ensure local cache reflects the applied state (including defaults)
             this.terrainHeightData[i] = height;
         }


        if (applied) {
            console.log('Applied height snapshot data to terrain geometry.');
        } else {
            console.warn('No valid height data found in snapshot, terrain set to flat.');
        }
         // Caller should handle needsUpdate and computeVertexNormals
         return applied;
    }

    // Apply a series of incremental height changes
    applyIncrementalHeightChanges(changeRecords) {
        if (!changeRecords || changeRecords.length === 0) return;

        console.log(`Applying ${changeRecords.length} incremental height changes.`);
        const positions = this.geometry.attributes.position;
        let vertexModified = false;

        // Sort changes chronologically before applying
        changeRecords.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        changeRecords.forEach(record => {
            if (!record.changes || typeof record.changes !== 'object') {
                console.warn('Skipping invalid height change record:', record.id);
                return;
            }
            if (this.processedChangeIds.has(record.id)) {
                 // console.log('Skipping already processed height change:', record.id);
                return; // Already processed
            }

            // Apply the vertex changes from this record
            Object.entries(record.changes).forEach(([indexStr, height]) => {
                const index = parseInt(indexStr);
                if (!isNaN(index) && index >= 0 && index < positions.count) {
                    positions.setY(index, height);
                    // Update the main height state cache
                    this.terrainHeightData[index] = height;
                    vertexModified = true;
                } else {
                    console.warn(`Invalid index ${indexStr} in change record ${record.id}`);
                }
            });
            this.processedChangeIds.add(record.id); // Mark this change ID as processed
        });

        if (vertexModified) {
             console.log('Applied incremental height changes to geometry.');
             // Caller should handle needsUpdate and computeVertexNormals
        }
        return vertexModified; // Return true if geometry was changed
    }


    // Called during mouse drag to accumulate changes for the current stroke
    accumulateHeightChange(index, newHeight) {
        // Check if height actually changed from the *base* state for this stroke
        // Only record the latest height for the vertex within this stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }


    // Save the accumulated changes from the finished stroke
    async saveTerrainChangesWithTimestamp(geometry) { // geometry might not be needed if state is trusted
        if (Object.keys(this.currentStrokeHeightChanges).length === 0) {
            console.log("No height changes in current stroke to save.");
            this.strokeStartTime = null; // Reset stroke time
            return;
        }

        const strokeEndTime = new Date().toISOString();
        const changesToSave = { ...this.currentStrokeHeightChanges };
        const changeCount = Object.keys(changesToSave).length;
        // Use current time as stroke start if somehow not set
        const strokeStartTime = this.strokeStartTime || new Date().toISOString();

        try {
            this.showSaveStatus(true, 'Saving height...');

            // Update the main terrainHeightData state immediately
            this.terrainHeightData = { ...this.terrainHeightData, ...changesToSave };

            // Create an incremental change record
            const changeRecord = await this.room.collection('terrainChange').create({
                changes: changesToSave, // Save only the changes from this stroke
                changeCount: changeCount,
                strokeStartTime: strokeStartTime,
                strokeEndTime: strokeEndTime
            });
            this.processedChangeIds.add(changeRecord.id); // Mark as processed locally

            console.log(`Saved ${changeCount} height changes for stroke.`);
            this.currentStrokeHeightChanges = {}; // Clear changes for the next stroke
            this.strokeStartTime = null; // Reset stroke time
            this.changesSinceSnapshot++;

            // Periodically create a full snapshot
            if (this.changesSinceSnapshot >= this.SNAPSHOT_THRESHOLD) {
                await this.createFullTerrainSnapshot();
                this.changesSinceSnapshot = 0; // Reset counter
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving terrain height changes:', error);
            this.showSaveStatus(false, true, 'Error saving height!');
            // Consider how to handle errors - maybe keep changes and retry?
            this.currentStrokeHeightChanges = {}; // Clear changes on error
            this.strokeStartTime = null;
        }
    }


    // Create a snapshot of the entire current terrain height state
    async createFullTerrainSnapshot() {
        try {
             console.log("Creating full terrain height snapshot...");
             // Use the locally cached full state
             if (Object.keys(this.terrainHeightData).length === 0) {
                 console.warn("Skipping height snapshot: No height data available.");
                 // This might happen if initialization failed badly
                 return;
             }
            const vertexCount = this.geometry.attributes.position.count;

            // Ensure terrainHeightData covers all vertices (important for initial/sparse data)
            const fullHeightData = { ...this.terrainHeightData };
            for(let i=0; i<vertexCount; i++) {
                if (fullHeightData[i] === undefined) {
                    fullHeightData[i] = this.geometry.attributes.position.getY(i); // Get from geometry if missing
                }
            }


            const snapshotRecord = await this.room.collection('terrainSnapshot').create({
                heightData: fullHeightData,
                vertexCount: vertexCount, // Use actual geometry vertex count
                timestamp: new Date().toISOString()
            });
            this.processedChangeIds.add(snapshotRecord.id); // Mark snapshot as processed
            console.log('Successfully created new terrain height snapshot.');

             // Optional: Clean up old incremental changes (See ColorManager for example)
             // await this.cleanupOldChanges(new Date());

        } catch (error) {
            console.error('Error creating terrain height snapshot:', error);
        }
    }

    // Create the initial flat terrain snapshot if none exists
    async createFlatTerrainSnapshot() {
        try {
             console.log("Creating initial flat terrain snapshot...");
             const positions = this.geometry.attributes.position;
             const heightData = {};
             this.terrainHeightData = {}; // Reset local cache

             for( let i = 0; i < positions.count; i++) {
                 heightData[i] = 0;
                 positions.setY(i, 0); // Set geometry flat
                 this.terrainHeightData[i] = 0; // Update local cache
             }

             // No need to update geometry visually here, loadTerrainData handles it

             // Save the initial snapshot
             const snapshotRecord = await this.room.collection('terrainSnapshot').create({
                 heightData: heightData,
                 vertexCount: positions.count,
                 isInitial: true,
                 timestamp: new Date().toISOString()
             });
             this.processedChangeIds.add(snapshotRecord.id); // Mark as processed
             console.log('Created and saved initial flat terrain snapshot.');
             return heightData; // Return the data for immediate application if needed

        } catch (error) {
            console.error('Error creating flat terrain snapshot:', error);
            throw error; // Re-throw to indicate initialization failure
        }
    }

    // Show save status indicator
    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;

        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';

        if (isVisible && !isError) {
            // Auto-hide for non-error messages
            setTimeout(() => {
                 // Check if the message is still the same saving message before hiding
                if (this.statusElement.textContent === message && !isError) {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}