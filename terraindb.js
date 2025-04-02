import * as THREE from 'three';

export class TerrainDatabase {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        // Represents the fully loaded/merged height state of the terrain
        this.terrainHeightData = {}; // Stores { vertexIndex: height }
        // Track the ID of the single canonical height state record
        this.canonicalHeightRecordId = null;
        // Track the timestamp of the currently applied height data to avoid loops
        this.lastAppliedTimestamp = null;
        this.myUsername = ''; // Set in initialize
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke before merging into terrainHeightData
        this.currentStrokeHeightChanges = {};
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        this.unsubscribeHeight = null; // To store unsubscribe function
        this.collectionName = 'terrainHeightState'; // Define collection name
    }

    async loadTerrainData() {
        this.isLoading = true;
        if (this.unsubscribeHeight) this.unsubscribeHeight(); // Unsubscribe from previous listener if any
        try {
            console.log(`[TerrainDB] Loading canonical state from collection: "${this.collectionName}"...`);
            const positions = this.geometry.attributes.position;

            // Fetch the list of state records (should ideally be just one canonical record)
            const states = await this.room.collection(this.collectionName).getList();
            console.log(`[TerrainDB] Fetched ${states.length} records from "${this.collectionName}". Raw data:`, JSON.stringify(states)); // Log raw data
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date just in case, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log(`[TerrainDB] Found latest state record: ID=${this.canonicalHeightRecordId}, Timestamp=${latestState.timestamp}`);
                if (this.applyHeightState(latestState)) { // Apply the initial state
                     console.log(`[TerrainDB] Applied initial height state ID: ${this.canonicalHeightRecordId}`);
                     // Ensure geometry reflects the update after applying
                     this.geometry.attributes.position.needsUpdate = true;
                     this.geometry.computeVertexNormals();
                } else {
                    console.log(`[TerrainDB] Initial state ID: ${this.canonicalHeightRecordId} was already applied (based on timestamp).`);
                }
            } else {
                console.log(`[TerrainDB] No canonical state found in "${this.collectionName}". Creating initial flat terrain state record.`);
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry, saves the first state, and applies it
                // Geometry update is handled within createFlatTerrainStateRecord's application flow
            }

            // Subscribe to future updates
            console.log(`[TerrainDB] Subscribing to "${this.collectionName}" collection...`);
            this.unsubscribeHeight = this.room.collection(this.collectionName).subscribe((incomingStates) => {
                 console.log(`[TerrainDB] Subscription triggered. Received ${incomingStates.length} states from "${this.collectionName}".`);
                if (this.isLoading) {
                    console.log("[TerrainDB] Skipping subscription update during initial load.");
                    return;
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                     console.log(`[TerrainDB] Processing subscription update: ID=${updatedState.id}, Timestamp=${updatedState.timestamp}, LastAppliedTS=${this.lastAppliedTimestamp}, CanonicalID=${this.canonicalHeightRecordId}`);
                    // Apply if it's a new state (different timestamp) for the canonical record OR if the canonical ID somehow changed
                    if (updatedState.id === this.canonicalHeightRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`[TerrainDB] Applying updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                        if (this.applyHeightState(updatedState)) { // Apply the full state
                            // Ensure geometry reflects the update
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals();
                             console.log("[TerrainDB] Geometry updated from height subscription.");
                        }
                    } else if (updatedState.id !== this.canonicalHeightRecordId) {
                        // Handle case where canonical ID has changed (e.g., data reset/migration)
                         console.warn(`[TerrainDB] Canonical height record ID changed from ${this.canonicalHeightRecordId} to ${updatedState.id}. Applying new state.`);
                         this.canonicalHeightRecordId = updatedState.id;
                         if (this.applyHeightState(updatedState)) {
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals();
                             console.log("[TerrainDB] Geometry updated from new canonical height ID via subscription.");
                         }
                    } else {
                         console.log(`[TerrainDB] Skipping subscription update: Same timestamp (${updatedState.timestamp}) or non-canonical ID.`);
                    }
                } else {
                    console.warn(`[TerrainDB] Canonical state subscription for "${this.collectionName}" returned empty list. Record might be deleted.`);
                    // Optional: Reset state if the canonical record disappears
                    // this.resetToDefaultState();
                }
            });

            console.log(`[TerrainDB] State loading process complete for "${this.collectionName}".`);

        } catch (error) {
            console.error(`[TerrainDB] Error loading terrain height state from "${this.collectionName}":`, error);
            // Fallback: ensure terrain is at least flat locally
            console.log("[TerrainDB] Applying default flat state due to loading error.");
            this.resetToDefaultState(); // Use a dedicated reset function
        } finally {
            this.isLoading = false; // Mark loading as complete *after* setup
            console.log(`[TerrainDB] isLoading set to false for "${this.collectionName}".`);
            // Ensure geometry is updated visually after initial load attempt finishes
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
             console.log(`[TerrainDB] Final geometry update check after load process for "${this.collectionName}".`);
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        console.log(`[TerrainDB] Attempting to apply height state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('[TerrainDB] Invalid height state data received:', stateData);
            stateData = { heightData: {}, timestamp: null }; // Use default empty data for reset
        }
         // Avoid re-applying the same state received via subscription or initial load
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            console.log(`[TerrainDB] Skipping application of height state: Timestamp ${stateData.timestamp} already applied.`);
            return false; // Indicate no change was made
        }

        console.log(`[TerrainDB] Applying canonical height state (TS: ${stateData.timestamp})...`);
        const positions = this.geometry.attributes.position;
        const loadedHeightData = stateData.heightData || {};
        const numLoadedKeys = Object.keys(loadedHeightData).length;
        console.log(`[TerrainDB] State contains ${numLoadedKeys} height entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;

        // Clear current local state before applying the new one
        this.terrainHeightData = {};

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const loadedHeight = loadedHeightData[i];
            const height = (loadedHeight !== undefined && loadedHeight !== null) ? Number(loadedHeight) : 0; // Default to 0 height

            positions.setY(i, height);
            // Ensure local cache reflects the applied state (including defaults)
            this.terrainHeightData[i] = height;

            if (loadedHeight !== undefined && loadedHeight !== null) {
                verticesApplied++;
            } else {
                verticesDefaulted++;
            }
        }

        console.log(`[TerrainDB] Applied height state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to 0.`);
        this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        // Caller handles geometry updates (needsUpdate, computeVertexNormals)
        return true; // Indicate that state was applied
    }

    // Called during mouse drag to stage changes for the current stroke
    accumulateHeightChange(index, newHeight) {
        // Store the latest height for this vertex within the current stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }

    // Save the *entire current* height state by updating the canonical record
    async saveTerrainChanges() {
        // Prevent saving during initial load
        if (this.isLoading) {
            console.log("[TerrainDB] Skipping save: Still loading initial height data.");
            return;
        }

        // Merge changes from the current stroke into the main state BEFORE checking if empty
        let changesFromStroke = Object.keys(this.currentStrokeHeightChanges).length > 0;
        if (changesFromStroke) {
             console.log(`[TerrainDB] Merging ${Object.keys(this.currentStrokeHeightChanges).length} height changes from stroke into canonical state.`);
            this.terrainHeightData = { ...this.terrainHeightData, ...this.currentStrokeHeightChanges };
            // Reset stroke changes AFTER successful merge
             this.currentStrokeHeightChanges = {};
        } else {
            console.log("[TerrainDB] No height changes accumulated in the current stroke. No save needed.");
            return; // If there were no changes in the stroke, we don't need to save.
        }


        // Double check if terrainHeightData is actually populated (should be after load or create)
        if (Object.keys(this.terrainHeightData).length === 0) {
            console.warn("[TerrainDB] Attempted to save but terrainHeightData is empty. Aborting save.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving height...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                heightData: this.terrainHeightData, // Save the complete state
                vertexCount: this.geometry.attributes.position.count, // Include for validation
                timestamp: currentTimestamp // Use timestamp to track updates
            };

            console.log(`[TerrainDB] Attempting to save height state to "${this.collectionName}". Record ID: ${this.canonicalHeightRecordId}. Timestamp: ${currentTimestamp}`);

            if (this.canonicalHeightRecordId) {
                // Update the existing canonical record
                await this.room.collection(this.collectionName).update(this.canonicalHeightRecordId, saveData);
                console.log(`[TerrainDB] Updated canonical height state record: ${this.canonicalHeightRecordId}`);
                // Update last applied timestamp locally immediately after successful save
                this.lastAppliedTimestamp = currentTimestamp;
            } else {
                // Create the first canonical record if it doesn't exist yet (should normally be created on load if empty)
                console.log(`[TerrainDB] Canonical height record ID (${this.canonicalHeightRecordId}) not found, creating new one...`);
                const newRecord = await this.room.collection(this.collectionName).create(saveData);
                this.canonicalHeightRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = currentTimestamp; // Set timestamp for the newly created record
                console.log(`[TerrainDB] Created new canonical height state record: ${this.canonicalHeightRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error(`[TerrainDB] Error saving terrain height state to "${this.collectionName}":`, error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Do NOT clear stroke changes here - allow user to retry potentially
             // Consider adding a retry mechanism or clearer error state.
        } finally {
             // Stroke changes were cleared *after* merge, before save attempt.
        }
    }

    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        try {
            console.log(`[TerrainDB] Creating initial flat terrain state record in "${this.collectionName}"...`);
            const positions = this.geometry.attributes.position;
            const heightData = {};
            this.terrainHeightData = {}; // Reset local cache

            for (let i = 0; i < positions.count; i++) {
                heightData[i] = 0;
                // We don't set geometry Y here directly, rely on applyHeightState
                this.terrainHeightData[i] = 0; // Update local cache
            }


            const initialTimestamp = new Date().toISOString();
            const saveData = {
                heightData: heightData,
                vertexCount: positions.count,
                isInitial: true,
                timestamp: initialTimestamp
            };

            // Apply this flat state locally *before* saving, to ensure consistency
            console.log("[TerrainDB] Applying initial flat state locally before save.");
             if (this.applyHeightState(saveData)) { // Pass saveData which includes the timestamp
                 // Mark geometry for update
                 this.geometry.attributes.position.needsUpdate = true;
                 this.geometry.computeVertexNormals();
                 console.log("[TerrainDB] Geometry updated for initial flat state.");
             }


            // Save the initial state record
            console.log(`[TerrainDB] Sending create request for initial flat height state to "${this.collectionName}"...`);
            const stateRecord = await this.room.collection(this.collectionName).create(saveData);
            this.canonicalHeightRecordId = stateRecord.id; // Store the ID of the created record
            // lastAppliedTimestamp was set during applyHeightState
            console.log(`[TerrainDB] Created and saved initial flat terrain state record: ${this.canonicalHeightRecordId}, TS: ${this.lastAppliedTimestamp}`);
            return heightData; // Return the data for reference

        } catch (error) {
            console.error(`[TerrainDB] Error creating flat terrain state record in "${this.collectionName}":`, error);
            throw error; // Re-throw to indicate initialization failure potential
        }
    }

     // Resets the terrain to a flat state locally (e.g., on error or if canonical record deleted)
    resetToDefaultState() {
        console.log("[TerrainDB] Resetting terrain to default flat state locally.");
        const flatStateData = {
            heightData: {}, // Empty data implies default height 0
            timestamp: null // No specific timestamp for a local reset
        };
        if (this.applyHeightState(flatStateData)) {
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
            console.log("[TerrainDB] Geometry updated after resetToDefaultState.");
        }
        this.canonicalHeightRecordId = null; // Clear canonical ID as we lost the state
        this.lastAppliedTimestamp = null; // Reset timestamp tracking
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