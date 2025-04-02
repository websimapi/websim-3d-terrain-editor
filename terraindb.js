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
        // Track the timestamp of the currently applied height data to avoid loops/redundancy
        this.lastAppliedTimestamp = null;
        this.myUsername = ''; // Set in initialize
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke before merging into terrainHeightData
        this.currentStrokeHeightChanges = {};
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        this.unsubscribeHeight = null; // To store unsubscribe function
    }

    async loadTerrainData() {
        this.isLoading = true;
        if (this.unsubscribeHeight) this.unsubscribeHeight(); // Unsubscribe from previous listener if any
        try {
            console.log("Loading canonical terrain height state...");
            const positions = this.geometry.attributes.position;

            // Fetch the list of state records (should ideally be just one canonical record)
            const states = await this.room.collection('terrainHeightState').getList();
            console.log(`Fetched ${states.length} terrainHeightState records.`);
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date just in case, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log(`Found latest height state record: ID=${this.canonicalHeightRecordId}, Timestamp=${latestState.timestamp}`);
                this.applyHeightState(latestState); // Apply the initial state
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state record.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry and saves the first state
            }

            // Subscribe to future updates
            console.log(`Subscribing to terrainHeightState collection...`);
            this.unsubscribeHeight = this.room.collection('terrainHeightState').subscribe((incomingStates) => {
                 console.log(`Height subscription triggered. Received ${incomingStates.length} states.`);
                if (this.isLoading) {
                    console.log("Skipping height subscription update during initial load.");
                    return;
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                     console.log(`Processing height update: ID=${updatedState.id}, CanonicalID=${this.canonicalHeightRecordId}, Timestamp=${updatedState.timestamp}, LastAppliedTS=${this.lastAppliedTimestamp}`);

                    // Apply if it's the canonical record (regardless of timestamp now)
                    // This ensures external updates are always applied.
                    // The local lastAppliedTimestamp is still updated after applying,
                    // and also immediately after a user saves their *own* changes,
                    // which helps prevent immediate re-application of one's own saves.
                    if (updatedState.id === this.canonicalHeightRecordId) {
                         // Check timestamp *only* for logging purposes, not for skipping application
                         if (updatedState.timestamp === this.lastAppliedTimestamp) {
                             console.log(`Applying height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}) - Timestamp matches last applied, but applying anyway.`);
                         } else {
                             console.log(`Applying updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                         }

                        if (this.applyHeightState(updatedState)) { // Apply the full state
                            // Ensure geometry reflects the update
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals();
                             console.log("Geometry updated from height subscription.");
                        } else {
                             console.log("applyHeightState indicated no change was needed (e.g., identical data).");
                        }
                    } else if (updatedState.id !== this.canonicalHeightRecordId && incomingStates.some(s => s.id === this.canonicalHeightRecordId)) {
                         // If the canonical ID is present but not the latest, log a warning but don't switch.
                         // This could happen in rare race conditions or if old records weren't cleaned up.
                         console.warn(`Received update where latest state ID (${updatedState.id}) does not match canonical ID (${this.canonicalHeightRecordId}), but canonical record exists in update list. Sticking with canonical record.`);
                         // Optional: Could try to find and apply the canonical record from the incomingStates list here if needed.
                    }
                    else if (updatedState.id !== this.canonicalHeightRecordId && !incomingStates.some(s => s.id === this.canonicalHeightRecordId)) {
                        // If the canonical ID we know is *gone* and a new latest exists, switch to it.
                         console.warn(`Canonical height record ID ${this.canonicalHeightRecordId} not found in latest updates. Switching canonical ID to ${updatedState.id}. Applying new state.`);
                         this.canonicalHeightRecordId = updatedState.id;
                         if (this.applyHeightState(updatedState)) {
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals();
                             console.log("Geometry updated from new canonical height ID.");
                         }
                    } else {
                         // This case should ideally not be reached with the above logic.
                         console.log("Skipping height update: Condition not met (should not happen?).");
                    }
                } else {
                    console.warn("Canonical height state subscription returned empty list. This might indicate the record was deleted.");
                    // Consider re-creating the flat state if desired:
                    // await this.createFlatTerrainStateRecord();
                }
            });

            console.log("Terrain height state loading process complete.");

        } catch (error) {
            console.error('Error loading terrain height state:', error);
            // Fallback: ensure terrain is at least flat locally
            console.log("Applying default flat state due to loading error.");
            this.applyHeightState({ heightData: {}, timestamp: null }); // Apply empty data to reset
        } finally {
            this.isLoading = false; // Mark loading as complete *after* setup
            console.log("isLoading set to false for terrain height.");
            // Ensure geometry is updated visually after initial load attempt
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
             console.log("Final geometry update after terrain height load.");
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        console.log(`Attempting to apply height state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('Invalid height state data received:', stateData);
            stateData = { heightData: {}, timestamp: null }; // Use default empty data for reset
        }
         // Avoid re-applying the same state *if the timestamp matches*.
         // This prevents redundant applications triggered by the subscription immediately
         // after our own save action, BUT allows external updates even if timestamp somehow matches.
         // The main subscription logic change already ensures external updates get through.
         // This check inside applyHeightState is a secondary guard against unnecessary processing.
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            // Check if the actual data has changed - this can happen if applyHeightState is called
            // directly after a local modification but before a save/subscription cycle.
            // A simple check: compare number of keys or a sample of values.
            // For simplicity, we'll still rely on the subscription logic handling most cases
            // and just log that we *would* skip based on timestamp if called directly.
            // The subscription logic now forces application anyway, overriding this check.
            // console.log(`Skipping application of height state: Timestamp ${stateData.timestamp} already applied.`);
            // return false; // Indicate no change was made based *only* on timestamp
            // --- Removed the actual return false based on timestamp alone ---
        }

        console.log(`Applying canonical height state (TS: ${stateData.timestamp})...`);
        const positions = this.geometry.attributes.position;
        const loadedHeightData = stateData.heightData || {};
        const numLoadedKeys = Object.keys(loadedHeightData).length;
        console.log(`State contains ${numLoadedKeys} height entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;
        let changeOccurred = false; // Track if any vertex *actually* changed height

        // Clear current local state before applying the new one
        // No, don't clear - we need to compare with the existing state to see if changes occurred
        // this.terrainHeightData = {}; // <-- Removed this line

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const loadedHeight = loadedHeightData[i];
            const targetHeight = (loadedHeight !== undefined && loadedHeight !== null) ? Number(loadedHeight) : 0; // Default to 0 height
            const currentHeight = positions.getY(i); // Get current height from geometry buffer

            // Only set if different from current geometry
            // Use a small tolerance for floating point comparison
            if (Math.abs(currentHeight - targetHeight) > 0.0001) {
                positions.setY(i, targetHeight);
                changeOccurred = true; // Mark that a change happened
                 // Update local cache ONLY if geometry was changed
                 this.terrainHeightData[i] = targetHeight;
            } else {
                // Ensure local cache is consistent even if no change needed
                // This handles cases where cache might be out of sync but geometry is correct
                if (this.terrainHeightData[i] !== targetHeight) {
                     this.terrainHeightData[i] = targetHeight;
                     // Don't set changeOccurred = true here, as geometry didn't update
                }
            }


            if (loadedHeight !== undefined && loadedHeight !== null) {
                verticesApplied++;
            } else {
                verticesDefaulted++;
            }
        }

        console.log(`Applied height state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to 0. Actual vertex height changes: ${changeOccurred}`);
        this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        // Caller handles geometry updates (needsUpdate, computeVertexNormals) IF changeOccurred is true
        return changeOccurred; // Indicate if state application resulted in geometry change
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
            console.log("Skipping save: Still loading initial height data.");
            return;
        }

        // Merge changes from the current stroke into the main state BEFORE checking if empty
        let changesFromStroke = Object.keys(this.currentStrokeHeightChanges).length > 0;
        if (changesFromStroke) {
             console.log(`Merging ${Object.keys(this.currentStrokeHeightChanges).length} height changes from stroke into canonical state.`);
            // Update the canonical data cache with the stroke changes
             Object.assign(this.terrainHeightData, this.currentStrokeHeightChanges);
             // Clear stroke changes *after* merging
             this.currentStrokeHeightChanges = {};
        } else {
            console.log("No height changes accumulated in the current stroke.");
            // If there were no changes in the stroke, we don't need to save.
            return;
        }


        // Double check if terrainHeightData is actually populated (should be after load or create)
        if (Object.keys(this.terrainHeightData).length === 0) {
            console.warn("Attempted to save but terrainHeightData is empty. Aborting save.");
             this.currentStrokeHeightChanges = {}; // Still clear stroke changes maybe? Or revert? For now, clear.
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

            console.log(`Attempting to save height state. Record ID: ${this.canonicalHeightRecordId}. Timestamp: ${currentTimestamp}`);

            if (this.canonicalHeightRecordId) {
                // Update the existing canonical record
                await this.room.collection('terrainHeightState').update(this.canonicalHeightRecordId, saveData);
                console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId}`);
                // Update last applied timestamp locally immediately after successful save.
                // This prevents the subscription update for our *own* change from causing a redundant application.
                this.lastAppliedTimestamp = currentTimestamp;
            } else {
                // Create the first canonical record if it doesn't exist yet
                console.log("Canonical height record ID not found, creating new one...");
                const newRecord = await this.room.collection('terrainHeightState').create(saveData);
                this.canonicalHeightRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = currentTimestamp; // Set timestamp for the newly created record
                console.log(`Created canonical height state record: ${this.canonicalHeightRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving terrain height state:', error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Consider how to handle errors - maybe revert local changes?
            // For now, clear stroke changes to avoid resaving the same failed data.
            this.currentStrokeHeightChanges = {};
        } finally {
             // Ensure stroke changes are cleared AFTER the attempt (success or fail)
             // This was already done after merge or if no changes, keep it this way.
             // this.currentStrokeHeightChanges = {}; // Redundant remove
        }
    }

    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        try {
            console.log("Creating initial flat terrain state record...");
            const positions = this.geometry.attributes.position;
            const heightData = {};
            this.terrainHeightData = {}; // Reset local cache

            for (let i = 0; i < positions.count; i++) {
                heightData[i] = 0;
                positions.setY(i, 0); // Set geometry flat
                this.terrainHeightData[i] = 0; // Update local cache
            }

            // Geometry update (needsUpdate, normals) handled by caller (loadTerrainData)

            const initialTimestamp = new Date().toISOString();
            const saveData = {
                heightData: heightData,
                vertexCount: positions.count,
                isInitial: true,
                timestamp: initialTimestamp
            };

            // Save the initial state record
            console.log("Sending create request for initial flat height state...");
            const stateRecord = await this.room.collection('terrainHeightState').create(saveData);
            this.canonicalHeightRecordId = stateRecord.id; // Store the ID of the created record
            this.lastAppliedTimestamp = initialTimestamp; // Track its timestamp
            console.log('Created and saved initial flat terrain state record:', this.canonicalHeightRecordId, 'TS:', initialTimestamp);
            return heightData; // Return the data for immediate application if needed

        } catch (error) {
            console.error('Error creating flat terrain state record:', error);
            throw error; // Re-throw to indicate initialization failure potential
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