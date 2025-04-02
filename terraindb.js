import * as THREE from 'three';

export class TerrainDatabase {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry; // Store geometry reference
        this.scene = scene;
        // Represents the fully loaded/merged height state of the terrain
        this.terrainHeightData = {}; // Stores { vertexIndex: height }
        // Track the ID of the single canonical height state record
        this.canonicalHeightRecordId = null;
        // Track the timestamp of the currently applied height data to avoid loops
        this.lastAppliedTimestamp = null;
        this.myUsername = ''; // Set later if needed
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke before merging into terrainHeightData
        this.currentStrokeHeightChanges = {};
        // Flag to prevent saving/applying during initial load
        this.isLoading = true;
        this.unsubscribeHeight = null; // To store unsubscribe function
    }

    async loadTerrainData() {
        this.isLoading = true; // Ensure loading flag is set
        if (this.unsubscribeHeight) {
            console.log("Unsubscribing from previous height listener.");
            this.unsubscribeHeight();
            this.unsubscribeHeight = null;
        }
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
                console.log(`Found latest height state record: ID=${this.canonicalHeightRecordId}, Timestamp=${latestState.timestamp || latestState.created_at}`);
                // Apply the initial state - this updates local cache and geometry positions
                this.applyHeightState(latestState);
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state record.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry, saves record, sets canonical ID/timestamp
            }

            // Subscribe to future updates AFTER initial load/creation attempt
            console.log(`Subscribing to terrainHeightState collection...`);
            this.unsubscribeHeight = this.room.collection('terrainHeightState').subscribe((incomingStates) => {
                // --- Subscription Callback ---
                if (this.isLoading) {
                    console.log("Height subscription triggered, but skipping update: Still in initial loading phase.");
                    return; // Do nothing if still loading initial data
                }
                console.log(`Height subscription triggered. Received ${incomingStates.length} states.`);
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    const updateTimestamp = updatedState.timestamp || updatedState.created_at; // Use timestamp if available
                    console.log(`Processing height update: ID=${updatedState.id}, Timestamp=${updateTimestamp}, LastAppliedTS=${this.lastAppliedTimestamp}`);

                    // Apply if it's a new state (different timestamp) for the canonical record OR if the canonical ID changed
                    if (updatedState.id === this.canonicalHeightRecordId && updateTimestamp !== this.lastAppliedTimestamp) {
                        console.log(`Applying updated height state via subscription (ID: ${updatedState.id}, TS: ${updateTimestamp})`);
                        if (this.applyHeightState(updatedState)) { // Apply the full state
                            // Ensure geometry reflects the update
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals(); // Recompute normals after height change
                            console.log("Geometry updated from height subscription.");
                        }
                    } else if (updatedState.id !== this.canonicalHeightRecordId) {
                        // This case handles if the canonical ID changed unexpectedly. Update and apply.
                        console.warn(`Canonical height record ID changed from ${this.canonicalHeightRecordId} to ${updatedState.id}. Applying new state.`);
                        this.canonicalHeightRecordId = updatedState.id;
                        if (this.applyHeightState(updatedState)) {
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals(); // Recompute normals
                            console.log("Geometry updated from new canonical height ID.");
                        }
                    } else {
                        console.log("Skipping height update: Same timestamp or non-canonical ID.");
                    }
                } else {
                    console.warn("Canonical height state subscription returned empty list. This might indicate the record was deleted.");
                    // Optional: Reset to flat state if canonical record disappears?
                    // this.applyHeightState({ heightData: {}, timestamp: null }); // Reset locally
                    // this.geometry.attributes.position.needsUpdate = true;
                    // this.geometry.computeVertexNormals();
                }
                // --- End Subscription Callback ---
            });

            console.log("Terrain height state loading process complete.");

        } catch (error) {
            console.error('Error loading terrain height state:', error);
            // Fallback: ensure terrain is at least flat locally
            console.warn("Applying default flat state due to loading error.");
            this.applyHeightState({ heightData: {}, timestamp: `error-${Date.now()}` }); // Apply empty data to reset, use unique timestamp
            // Ensure geometry reflects the fallback state
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
        } finally {
            this.isLoading = false; // Mark loading as complete *after* all setup/subscribe
            console.log("isLoading set to false for terrain height.");
            // Note: Final geometry update (needsUpdate, normals) is handled in initializeMultiplayer in main.js
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        const incomingTimestamp = stateData?.timestamp || stateData?.created_at; // Prefer explicit timestamp
        console.log(`Attempting to apply height state. Incoming TS: ${incomingTimestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);

        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('Invalid height state data received:', stateData);
            // Use default empty data for reset, generate a unique timestamp to ensure application
            stateData = { heightData: {}, timestamp: `invalid-${Date.now()}` };
        }

        // Avoid re-applying the same state received via subscription or initial load
        // Check against the incoming timestamp
        if (incomingTimestamp && incomingTimestamp === this.lastAppliedTimestamp) {
            console.log(`Skipping application of height state: Timestamp ${incomingTimestamp} already applied.`);
            return false; // Indicate no change was made
        }

        console.log(`Applying canonical height state (TS: ${incomingTimestamp})...`);
        const positions = this.geometry.attributes.position;
        const loadedHeightData = stateData.heightData || {};
        const numLoadedKeys = Object.keys(loadedHeightData).length;
        console.log(`State contains ${numLoadedKeys} height entries for ${positions.count} vertices.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;

        // Clear current local state before applying the new one
        this.terrainHeightData = {};

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const loadedHeight = loadedHeightData[i];
            // Ensure conversion to Number, default to 0
            const height = (loadedHeight !== undefined && loadedHeight !== null && !isNaN(Number(loadedHeight))) ? Number(loadedHeight) : 0;

            // Apply directly to geometry buffer
            positions.setY(i, height);

            // Ensure local cache reflects the applied state (including defaults)
            this.terrainHeightData[i] = height;

            if (loadedHeight !== undefined && loadedHeight !== null && !isNaN(Number(loadedHeight))) {
                verticesApplied++;
            } else {
                if (loadedHeight !== undefined && loadedHeight !== null) { // Log if it existed but was NaN
                    console.warn(`Height data at index ${i} was not a valid number: ${loadedHeight}. Defaulting to 0.`);
                }
                verticesDefaulted++;
            }
        }

        console.log(`Applied height state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to 0.`);
        // Track the timestamp of the applied data
        this.lastAppliedTimestamp = incomingTimestamp;
        // Mark geometry buffer for update - caller (load or subscription) handles this now
        // this.geometry.attributes.position.needsUpdate = true; // Moved to caller
        // Caller also handles computeVertexNormals
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
            console.log("Skipping height save: Still loading initial height data.");
            return; // Return a resolved promise or throw? Resolve seems safer.
        }

        // Merge changes from the current stroke into the main state BEFORE checking if empty
        let changesFromStroke = Object.keys(this.currentStrokeHeightChanges).length > 0;
        if (changesFromStroke) {
            console.log(`Merging ${Object.keys(this.currentStrokeHeightChanges).length} height changes from stroke into canonical state.`);
            // Merge efficiently: overwrite existing keys in terrainHeightData
            Object.assign(this.terrainHeightData, this.currentStrokeHeightChanges);
            this.currentStrokeHeightChanges = {}; // Reset stroke changes AFTER successful merge
        } else {
            console.log("No height changes accumulated in the current stroke. No save needed.");
            return; // Nothing to save
        }

        // Double check if terrainHeightData is actually populated (should be after load or create)
        if (Object.keys(this.terrainHeightData).length === 0) {
            console.warn("Attempted to save but terrainHeightData is empty after merge. Aborting save.");
            this.currentStrokeHeightChanges = {}; // Clear just in case
            return;
        }

        // Ensure we have a canonical record ID
        if (!this.canonicalHeightRecordId) {
            console.error("Cannot save height changes: Canonical Record ID is missing.");
            // Maybe try to re-fetch/re-create? For now, just log error and abort save.
            this.currentStrokeHeightChanges = {}; // Clear changes that couldn't be saved
            this.showSaveStatus(false, 'Save Error: No Record ID!', true);
            // Consider re-throwing or returning a rejected promise
            throw new Error("Cannot save height: Missing canonicalHeightRecordId");
        }

        try {
            this.showSaveStatus(true, 'Saving height...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                heightData: this.terrainHeightData, // Save the complete state
                vertexCount: this.geometry.attributes.position.count, // Include for validation
                timestamp: currentTimestamp // Use timestamp to track updates
            };

            console.log(`Attempting to update height state record: ${this.canonicalHeightRecordId}. Timestamp: ${currentTimestamp}`);

            // Update the existing canonical record
            await this.room.collection('terrainHeightState').update(this.canonicalHeightRecordId, saveData);
            console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId}`);

            // Update last applied timestamp locally immediately after successful save
            // This prevents the subscription (if it arrives quickly) from re-applying our own change
            this.lastAppliedTimestamp = currentTimestamp;

            this.showSaveStatus(false); // Hides status indicator

        } catch (error) {
            console.error('Error saving terrain height state:', error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Don't clear terrainHeightData, but clear stroke changes
            this.currentStrokeHeightChanges = {};
            throw error; // Re-throw the error so Promise.all in onPointerUp knows it failed
        } finally {
            // Ensure stroke changes are always cleared after a save attempt (success or fail)
            // Moved the reset inside the try/catch blocks for clarity
        }
    }

    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        // This function now also applies the flat state to the geometry and sets lastAppliedTimestamp
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
            this.lastAppliedTimestamp = initialTimestamp; // Track its timestamp immediately
            console.log('Created and saved initial flat terrain state record:', this.canonicalHeightRecordId, 'TS:', initialTimestamp);

            // Mark geometry as needing update since we modified it
            this.geometry.attributes.position.needsUpdate = true;
            // Normals computation will be handled by the caller (loadTerrainData's final steps or initializeMultiplayer)

            return heightData; // Return the data (though it's already applied)

        } catch (error) {
            console.error('Error creating flat terrain state record:', error);
            // If creation fails, we might be in an inconsistent state.
            // Set canonical ID and timestamp to null to indicate failure.
            this.canonicalHeightRecordId = null;
            this.lastAppliedTimestamp = null;
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