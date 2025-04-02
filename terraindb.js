import * as THREE from 'three';

// Use a new collection name to avoid conflicts with the old schema
const TERRAIN_HEIGHT_COLLECTION = 'terrainHeight_v2';

export class TerrainDatabase {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.myUsername = '';
        this.myRecordId = null; // ID of the current user's terrain height record
        // Stores the complete height data for the current user, loaded or initialized
        this.currentUserHeightData = {};
        // Stores the merged height data from all users
        this.mergedTerrainHeightData = {};
        this.statusElement = document.getElementById('save-status');
        this.isSaving = false;
        this.saveQueued = false;
        this.unsubscribe = null; // To store the unsubscribe function
    }

    async initialize() {
        // Ensure we have the username before proceeding
        while (!this.room.clientId || !this.room.peers[this.room.clientId]) {
            console.log("Waiting for room client ID and peer info...");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.myUsername = this.room.peers[this.room.clientId].username;
        if (!this.myUsername) {
             console.error("Failed to get username, cannot initialize TerrainDatabase correctly.");
             return;
        }
        console.log(`TerrainDatabase initializing for user: ${this.myUsername}`);
        await this.loadAndMergeAllTerrainData();
    }

    // Called during mouse drag by main.js to modify the user's local data
    applyHeightChange(index, newHeight) {
        // Directly modify the user's local data copy
        this.currentUserHeightData[String(index)] = newHeight;
        // Also update the merged data immediately for visual feedback
        this.mergedTerrainHeightData[String(index)] = newHeight;
        // Mark geometry for update locally
        this.geometry.attributes.position.setY(index, newHeight);
        this.geometry.attributes.position.needsUpdate = true; // Could optimize this
        this.geometry.computeVertexNormals(); // Could optimize this
    }

    // Load all user records, merge them, apply to geometry, and subscribe
    async loadAndMergeAllTerrainData() {
        try {
            console.log(`Loading all terrain data from ${TERRAIN_HEIGHT_COLLECTION}...`);
            if (this.unsubscribe) {
                this.unsubscribe(); // Unsubscribe from previous listener if exists
                this.unsubscribe = null;
                console.log("Unsubscribed from previous terrain height listener.");
            }

            const allRecords = await this.room.collection(TERRAIN_HEIGHT_COLLECTION).getList();
            console.log(`Found ${allRecords.length} height records.`);

            this.mergeRecords(allRecords);

            // Find or initialize current user's record data
            const myRecord = allRecords.find(r => r.username === this.myUsername);
            if (myRecord) {
                console.log("Found existing record for user:", this.myUsername);
                this.myRecordId = myRecord.id;
                // Ensure local data starts consistent with the record
                this.currentUserHeightData = { ...(myRecord.heightData || {}) };
                 // Make sure merged data also includes user's latest record data initially
                this.mergeRecords(allRecords); // Re-merge AFTER finding user record
            } else {
                console.log("No existing record for user, will create on first save.");
                this.myRecordId = null;
                 // Initialize with current geometry state (should be flat or from initial load)
                const positions = this.geometry.attributes.position;
                 this.currentUserHeightData = {};
                 for (let i = 0; i < positions.count; i++) {
                     this.currentUserHeightData[String(i)] = positions.getY(i);
                 }
            }

            this.applyMergedDataToGeometry();

            // Subscribe to future changes in ANY record in the collection
            this.unsubscribe = this.room.collection(TERRAIN_HEIGHT_COLLECTION).subscribe((updatedRecords) => {
                console.log(`Subscription update: Received ${updatedRecords.length} height records.`);
                 // Check if our record ID changed (e.g., deleted and recreated)
                 const myNewRecord = updatedRecords.find(r => r.username === this.myUsername);
                 this.myRecordId = myNewRecord ? myNewRecord.id : null;
                 if (myNewRecord && !this.isSaving) { // Avoid overwriting local changes while saving
                     // Update local copy only if not currently saving to avoid conflicts
                     this.currentUserHeightData = { ...(myNewRecord.heightData || {}) };
                 }

                this.mergeRecords(updatedRecords);
                this.applyMergedDataToGeometry();
            });
            console.log(`Subscribed to ${TERRAIN_HEIGHT_COLLECTION} updates.`);

        } catch (error) {
            console.error('Error loading and merging terrain height data:', error);
        }
    }

    // Merge data from multiple records (last update wins per vertex)
    mergeRecords(records) {
        console.log(`Merging ${records.length} height records...`);
        const newMergedData = {};
        const lastUpdatePerVertex = {}; // { vertexIndex: timestamp_ms }

        // Sort records by update time (oldest first)
        const sortedRecords = records.sort((a, b) => {
             // Use created_at as records are updated in place now
            const timeA = new Date(a.created_at).getTime();
            const timeB = new Date(b.created_at).getTime();
            return timeA - timeB;
        });


        for (const record of sortedRecords) {
            if (!record.heightData || typeof record.heightData !== 'object') continue;
            const recordTimestamp = new Date(record.created_at).getTime(); // Use created_at

            for (const [indexStr, height] of Object.entries(record.heightData)) {
                 // No need to check timestamp here, simple overwrite works due to sorting
                 newMergedData[indexStr] = height;
            }
        }
         this.mergedTerrainHeightData = newMergedData;
         console.log(`Merging complete. Merged vertices: ${Object.keys(this.mergedTerrainHeightData).length}`);
    }

    // Apply the merged data to the Three.js geometry
    applyMergedDataToGeometry() {
        console.log("Applying merged height data to geometry...");
        const positions = this.geometry.attributes.position;
        let vertexModified = false;
        const defaultHeight = 0; // Fallback height if not in merged data

        for (let i = 0; i < positions.count; i++) {
            const indexStr = String(i);
            const targetHeight = this.mergedTerrainHeightData[indexStr] !== undefined
                ? this.mergedTerrainHeightData[indexStr]
                : defaultHeight; // Use default if vertex not in any record

            if (Math.abs(positions.getY(i) - targetHeight) > 0.001) {
                 positions.setY(i, targetHeight);
                 vertexModified = true;
            }
            // Ensure currentUserHeightData also reflects the initial merged state for vertices
            // they haven't modified yet in this session.
             if (this.currentUserHeightData[indexStr] === undefined) {
                 this.currentUserHeightData[indexStr] = targetHeight;
             }
        }

        if (vertexModified) {
            positions.needsUpdate = true;
            this.geometry.computeVertexNormals();
            console.log('Geometry updated with merged height data.');
        } else {
            console.log('Geometry already up-to-date with merged height data.');
        }
    }

    // Save the user's complete terrain data (updates existing or creates new)
    async saveTerrainChanges() {
        if (this.isSaving) {
             console.log("Save already in progress, queueing next save.");
             this.saveQueued = true;
            return;
        }
        if (!this.myUsername) {
            console.error("Cannot save terrain changes, username is not set.");
            return;
        }

        this.isSaving = true;
        this.showSaveStatus(true, 'Saving height...');
        console.log("Attempting to save terrain height changes for user:", this.myUsername);

        const dataToSave = { ...this.currentUserHeightData };
        const vertexCount = Object.keys(dataToSave).length;
        // Use current timestamp for updated_at (Websim handles created_at)
        const updateTimestamp = new Date().toISOString();


        try {
            if (this.myRecordId) {
                // Update existing record
                console.log(`Updating record ${this.myRecordId} for ${this.myUsername}`);
                await this.room.collection(TERRAIN_HEIGHT_COLLECTION).update(this.myRecordId, {
                    heightData: dataToSave,
                    vertexCount: vertexCount,
                    updated_at: updateTimestamp // Explicitly track update time
                });
                console.log(`Successfully updated record ${this.myRecordId}`);
            } else {
                // Create new record
                 console.log(`Creating new record for ${this.myUsername}`);
                const newRecord = await this.room.collection(TERRAIN_HEIGHT_COLLECTION).create({
                    heightData: dataToSave,
                    vertexCount: vertexCount,
                    // username is handled automatically
                    updated_at: updateTimestamp // Explicitly track update time
                 });
                 this.myRecordId = newRecord.id; // Store the new record ID
                 console.log(`Successfully created new record ${this.myRecordId}`);
            }
            this.showSaveStatus(false); // Hide status indicator
        } catch (error) {
            console.error(`Error saving terrain height data for ${this.myUsername}:`, error);
            this.showSaveStatus(true, 'Error saving height!', true); // Show error
             // Keep showing error for a bit
             setTimeout(() => this.showSaveStatus(false), 3000);
        } finally {
            this.isSaving = false;
             if (this.saveQueued) {
                 this.saveQueued = false;
                 console.log("Processing queued save request.");
                 // Use setTimeout to avoid potential infinite loops on rapid errors
                 setTimeout(() => this.saveTerrainChanges(), 100);
             }
        }
    }

    // Show save status indicator
    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;

        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';

        // Auto-hide for non-error messages after a delay
        if (isVisible && !isError) {
            setTimeout(() => {
                // Only hide if the status hasn't changed (e.g., to an error)
                if (this.statusElement.textContent === message && !this.isSaving && !isError) {
                   this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
         // Don't auto-hide error messages, they require user attention or success
    }

    // Clean up subscription on disconnect/unload
    dispose() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
            console.log("Unsubscribed from terrain height updates on dispose.");
        }
    }
}