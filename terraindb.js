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
        // Flag to track if the initial load created the state record
        this.initialLoadCreatedState = false;
    }

    async loadTerrainData() {
        this.isLoading = true;
        this.initialLoadCreatedState = false; // Reset flag
        if (this.unsubscribeHeight) this.unsubscribeHeight(); // Unsubscribe from previous listener if any
        const positions = this.geometry.attributes.position; // Get positions reference once

        try {
            console.log("Loading canonical terrain height state...");

            // Fetch the list of state records (should ideally be just one canonical record)
            const states = await this.room.collection('terrainHeightState').getList();
            console.log(`Fetched ${states.length} terrainHeightState records.`);
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date just in case, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log(`Applying initial height state: ID=${this.canonicalHeightRecordId}, Timestamp=${latestState.timestamp}`);
                this.applyHeightState(latestState); // Apply the initial state
                console.log("Initial height state applied. positions.needsUpdate should be true.");
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state record.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry and saves the first state
                positions.needsUpdate = true; // Ensure update after manual flattening in createFlat
                this.initialLoadCreatedState = true; // Mark that we created the initial state
                console.log("Initial flat state created. positions.needsUpdate should be true.");
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

                    // Apply if it's the canonical record AND the timestamp is different OR if the canonical ID changed
                    let shouldApply = false;
                    if (updatedState.id === this.canonicalHeightRecordId) {
                        if (updatedState.timestamp !== this.lastAppliedTimestamp) {
                            console.log(`Applying updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                            shouldApply = true;
                        } else {
                            console.log(`Skipping height update: Same timestamp for canonical ID (${updatedState.timestamp}).`);
                        }
                    } else if (incomingStates.some(s => s.id === this.canonicalHeightRecordId)) {
                        console.warn(`Received update where latest state ID (${updatedState.id}) does not match canonical ID (${this.canonicalHeightRecordId}), but canonical record exists in update list. Sticking with canonical record. No update applied.`);
                        // Potentially find and apply the canonical one if its timestamp is new? For now, do nothing.
                    } else {
                        // If the canonical ID we know is *gone* and a new latest exists, switch to it.
                        console.warn(`Canonical height record ID ${this.canonicalHeightRecordId} not found in latest updates. Switching canonical ID to ${updatedState.id}. Applying new state.`);
                        this.canonicalHeightRecordId = updatedState.id;
                        shouldApply = true; // Apply the new canonical state regardless of timestamp comparison with old record
                    }

                    if (shouldApply) {
                        // applyHeightState now always sets needsUpdate=true if it applies data
                        this.applyHeightState(updatedState);
                        // Recompute normals *after* applying the update
                        this.geometry.computeVertexNormals();
                        console.log("Geometry updated and normals recomputed from height subscription.");
                    }

                } else {
                    console.warn("Canonical height state subscription returned empty list. This might indicate the record was deleted.");
                    // Resetting could cause data loss if it's temporary. Consider adding a delay or manual reset button.
                }
            });

            console.log("Terrain height state loading process complete.");

        } catch (error) {
            console.error('Error loading terrain height state:', error);
            // Fallback: ensure terrain is at least flat locally
            console.log("Applying default flat state due to loading error.");
            this.applyHeightState({ heightData: {}, timestamp: null }); // Apply empty data to reset
            positions.needsUpdate = true; // Ensure update after reset
        } finally {
            this.isLoading = false; // Mark loading as complete *after* setup
            console.log("isLoading set to false for terrain height.");
            // Ensure geometry vertex normals are computed after initial load/creation attempt
            // This is crucial for correct lighting after height changes.
            console.log("Computing vertex normals after initial terrain height load/create.");
            this.geometry.computeVertexNormals();
            // Ensure the geometry is visually updated in the renderer in the next frame
            // This should already be set by applyHeightState or createFlatTerrainStateRecord
            // but set again for absolute certainty.
            positions.needsUpdate = true;
            console.log("Final position attribute marked needsUpdate after terrain height load.");
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        console.log(`Attempting to apply height state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('Invalid height state data received:', stateData);
            stateData = { heightData: {}, timestamp: null }; // Use default empty data for reset
        }

        // Skip if timestamp matches *unless* it's the state we just created on initial load
        // This prevents the subscription immediately applying the state we *just* created unnecessarily
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp && !(this.initialLoadCreatedState && this.isLoading)) {
            console.log(`Skipping application of height state: Timestamp ${stateData.timestamp} already applied.`);
            return false; // Indicate no change needed based on timestamp
        }

        console.log(`Applying canonical height state (TS: ${stateData.timestamp})...`);
        const positions = this.geometry.attributes.position;
        const loadedHeightData = stateData.heightData || {};
        const numLoadedKeys = Object.keys(loadedHeightData).length;
        console.log(`State contains ${numLoadedKeys} height entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;

        // Clear local cache before applying the new state data
        this.terrainHeightData = {};

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const loadedHeight = loadedHeightData[i];
            // Default to 0 height if undefined or null in the loaded data
            const targetHeight = (loadedHeight !== undefined && loadedHeight !== null) ? Number(loadedHeight) : 0;

            // Set the geometry buffer Y coordinate from the loaded state data
            positions.setY(i, targetHeight);

            // Update local cache to match the applied state
            this.terrainHeightData[i] = targetHeight;

            // Track counts for logging
            if (loadedHeight !== undefined && loadedHeight !== null) {
                verticesApplied++;
            } else {
                verticesDefaulted++;
            }
        }

        // *** ALWAYS mark the position attribute as needing update after applying a full state ***
        positions.needsUpdate = true;

        console.log(`Applied height state (TS: ${stateData.timestamp}). ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted. Geometry buffer updated directly. Marked needsUpdate=true.`);
        this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data

        // Return true indicating the buffer was modified and needsUpdate was set.
        return true;
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
            console.log("No height changes accumulated in the current stroke. No save needed.");
            // If there were no changes in the stroke, we don't need to save.
            return;
        }

        // Double check if terrainHeightData is actually populated (should be after load or create)
        if (Object.keys(this.terrainHeightData).length === 0) {
            console.warn("Attempted to save but terrainHeightData is empty. Aborting save.");
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
            this.currentStrokeHeightChanges = {}; // Ensure cleared on error too
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
                positions.setY(i, 0); // *** Set geometry flat directly ***
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