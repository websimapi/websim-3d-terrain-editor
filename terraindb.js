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
        // Flag to prevent saving while loading initial data or during application
        this.isProcessing = false;
        this.unsubscribe = null; // To store the unsubscribe function
        this.statusTimeout = null;
    }

    async loadTerrainData() {
        this.isProcessing = true;
        try {
            console.log("Loading canonical terrain height state...");
            const positions = this.geometry.attributes.position;

            // Unsubscribe from previous listeners if any
            if (this.unsubscribe) {
                this.unsubscribe();
                this.unsubscribe = null;
                console.log("Unsubscribed from previous height state listener.");
            }

            // GetList returns newest first according to docs
            const states = await this.room.collection('terrainHeightState').getList();
            let latestState = null;

            if (states.length > 0) {
                latestState = states[0]; // Get the newest (should be the only one)
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log('Found existing terrain height state from record:', this.canonicalHeightRecordId, 'Timestamp:', latestState.timestamp);
                this.applyHeightState(latestState); // Apply initial state
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry, saves, and sets ID/timestamp
            }

            // Subscribe to future updates of the canonical state record
            this.unsubscribe = this.room.collection('terrainHeightState').subscribe((incomingStates) => {
                // Don't process updates during initial load or while saving/applying
                if (this.isProcessing) {
                    console.log("Skipping height subscription update while processing.");
                    return;
                }
                if (incomingStates.length > 0) {
                    // Get the latest state (should be the only one, but sort to be sure)
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

                    // Check if the incoming state is genuinely newer than what we last applied
                    if (updatedState.id === this.canonicalHeightRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        this.isProcessing = true; // Prevent concurrent processing
                        console.log(`Received updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.applyHeightState(updatedState); // Apply the full state
                        // Ensure geometry reflects the update
                        this.geometry.attributes.position.needsUpdate = true;
                        this.geometry.computeVertexNormals();
                        this.isProcessing = false; // Release lock
                    } else if (updatedState.id !== this.canonicalHeightRecordId) {
                        // This case might indicate an issue (e.g., multiple records somehow created)
                        console.warn(`Received state for a different ID (${updatedState.id}) than expected (${this.canonicalHeightRecordId}). Ignoring.`);
                    } else {
                        // Timestamp matched, likely an echo of our own save or already applied
                        // console.log("Skipping height subscription update: Timestamp matches last applied.");
                    }
                } else {
                    console.warn("Canonical height state subscription returned empty list. This might indicate the record was deleted.");
                    // Could attempt recreation or signal an error
                }
            });

            console.log("Terrain height state loading and subscription setup complete.");

        } catch (error) {
            console.error('Error loading terrain height state:', error);
            // Fallback: ensure terrain is at least flat locally
            this.applyHeightState({ heightData: {}, timestamp: null }); // Apply empty data to reset
        } finally {
            // Ensure geometry is updated visually after loading attempt
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
            // Allow saving/processing now that initial load finished (or failed)
            // Set processing to false slightly later to allow initial render frame
            setTimeout(() => { this.isProcessing = false; }, 100);
            console.log("Load complete, isProcessing set to false.");
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        // Avoid re-applying the same state based on timestamp
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            console.log("Skipping application of already current height state (Timestamp match).");
            return false;
        }
        // Ensure data is valid, default to empty object if not
        const heightData = (stateData && typeof stateData.heightData === 'object') ? stateData.heightData : {};

        console.log("Applying canonical height state...");
        const positions = this.geometry.attributes.position;
        let applied = false;
        // Directly replace local state with the loaded state data
        // Create a new object reference to ensure change detection if needed elsewhere
        this.terrainHeightData = { ...heightData };

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            // Use Number() to ensure type is correct, default to 0
            const height = this.terrainHeightData[i] !== undefined ? Number(this.terrainHeightData[i]) : 0;
            // Check if the height actually needs changing to avoid unnecessary updates
            if (positions.getY(i) !== height) {
                positions.setY(i, height);
                applied = true; // Mark that a change occurred
            }
            // Ensure local cache reflects the applied state (including defaults)
            // This ensures consistency even if the input data was sparse
            this.terrainHeightData[i] = height;
        }

        if (applied) {
            console.log('Applied canonical height state data to terrain geometry.');
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of the applied data
            // Geometry update (needsUpdate, normals) handled by the caller (load or subscription handler)
            return true;
        } else {
            // Even if no vertices changed, update timestamp if the incoming state's timestamp is newer
            if (stateData.timestamp && (!this.lastAppliedTimestamp || stateData.timestamp > this.lastAppliedTimestamp)) {
                this.lastAppliedTimestamp = stateData.timestamp;
                console.log("Updated lastAppliedTimestamp even though geometry was already up-to-date.");
            }
            console.log('Height geometry was already up-to-date with the received state.');
            return false;
        }
    }

    // Called during mouse drag to stage changes for the current stroke
    accumulateHeightChange(index, newHeight) {
        // Store the latest height for this vertex within the current stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }

    // Save the *entire current* height state by updating the canonical record
    async saveTerrainChanges() {
        // Prevent saving during initial load or if already saving/applying state
        if (this.isProcessing) {
            console.log("Skipping save: Still processing initial load or another operation.");
            return;
        }

        // Merge changes from the current stroke into the main state
        let changesToSave = false;
        if (Object.keys(this.currentStrokeHeightChanges).length > 0) {
            // Check if any accumulated changes are different from the current state
            for (const index in this.currentStrokeHeightChanges) {
                if (this.terrainHeightData[index] !== this.currentStrokeHeightChanges[index]) {
                    changesToSave = true;
                    break;
                }
            }
            if (changesToSave) {
                this.terrainHeightData = { ...this.terrainHeightData, ...this.currentStrokeHeightChanges };
            }
            this.currentStrokeHeightChanges = {}; // Reset stroke changes regardless
        }

        if (!changesToSave) {
            console.log("No effective height changes in current stroke to save.");
            return; // No need to save if nothing actually changed
        }

        // Prevent saving if no data exists (shouldn't happen after initialization)
        if (Object.keys(this.terrainHeightData).length === 0) {
            console.log("Skipping save: No height data available.");
            return;
        }

        this.isProcessing = true; // Lock to prevent concurrent saves/loads
        try {
            this.showSaveStatus(true, 'Saving height...');

            const newTimestamp = new Date().toISOString(); // Generate timestamp *before* save attempt
            const saveData = {
                heightData: this.terrainHeightData,
                vertexCount: this.geometry.attributes.position.count,
                timestamp: newTimestamp
            };

            if (this.canonicalHeightRecordId) {
                // Update the existing canonical record
                await this.room.collection('terrainHeightState').update(this.canonicalHeightRecordId, saveData);
                console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId}`);
                // Update local timestamp *after* successful save
                this.lastAppliedTimestamp = newTimestamp;
            } else {
                // Create the first canonical record if it doesn't exist yet (fallback, should be created on load)
                console.warn("Canonical height record ID not found during save attempt, creating new one...");
                const newRecord = await this.room.collection('terrainHeightState').create(saveData);
                this.canonicalHeightRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = newTimestamp; // Set timestamp for the newly created record
                console.log(`Created canonical height state record: ${this.canonicalHeightRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving terrain height state:', error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Keep isProcessing true? Or release? Releasing allows retry.
            // If we don't update lastAppliedTimestamp, the next subscription might fix it if another user saves.
        } finally {
            this.currentStrokeHeightChanges = {}; // Always clear stroke changes after attempt
            this.isProcessing = false; // Release lock
            console.log("Save attempt finished, isProcessing set to false.");
        }
    }

    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        // Note: This is typically called from loadTerrainData when no record exists
        console.log("Executing createFlatTerrainStateRecord...");
        const positions = this.geometry.attributes.position;
        const heightData = {};
        this.terrainHeightData = {}; // Reset local cache

        for (let i = 0; i < positions.count; i++) {
            heightData[i] = 0;
            positions.setY(i, 0); // Set geometry flat
            this.terrainHeightData[i] = 0; // Update local cache
        }

        // Geometry update (needsUpdate, normals) handled by the caller (loadTerrainData)

        const newTimestamp = new Date().toISOString();
        const saveData = {
            heightData: heightData,
            vertexCount: positions.count,
            isInitial: true,
            timestamp: newTimestamp
        };

        try {
            // Save the initial state record
            const stateRecord = await this.room.collection('terrainHeightState').create(saveData);
            this.canonicalHeightRecordId = stateRecord.id; // Store the ID of the created record
            this.lastAppliedTimestamp = newTimestamp; // Track its timestamp locally
            console.log('Created and saved initial flat terrain state record:', this.canonicalHeightRecordId);
            return heightData; // Return the data for immediate application if needed

        } catch (error) {
            console.error('Error creating flat terrain state record:', error);
            // Don't set ID or timestamp if creation failed
            this.canonicalHeightRecordId = null;
            this.lastAppliedTimestamp = null;
            throw error; // Re-throw to indicate initialization failure potential
        }
    }

    // Show save status indicator
    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;

        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        this.statusElement.style.color = isError ? 'white' : 'white'; // Ensure text is visible

        // Clear previous timeouts if any
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }

        if (isVisible && !isError) {
            // Auto-hide for non-error messages
            this.statusTimeout = setTimeout(() => {
                // Check if the message is still the same saving message before hiding
                if (this.statusElement.textContent === message && !isError) {
                    this.hideSaveStatus();
                }
            }, 1500);
        } else if (!isVisible) {
            // If hiding manually, ensure timeout is cleared
            if (this.statusTimeout) clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
        // Error messages remain visible until the next status update
    }

    hideSaveStatus() {
        if (!this.statusElement) return;
        this.statusElement.style.opacity = '0';
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
    }
}