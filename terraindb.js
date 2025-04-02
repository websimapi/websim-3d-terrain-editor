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
    }

    async loadTerrainData() {
        this.isLoading = true;
        try {
            console.log("Loading canonical terrain height state...");
            const positions = this.geometry.attributes.position;

            // Fetch the list of state records (should ideally be just one)
            const states = await this.room.collection('terrainHeightState').getList();
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date just in case, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log('Applying initial terrain height state from record:', this.canonicalHeightRecordId, 'Timestamp:', latestState.timestamp);
                this.applyHeightState(latestState);
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry and saves the first state
            }

            // Subscribe to future updates of the canonical state record
            this.room.collection('terrainHeightState').subscribe((incomingStates) => {
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    // Check if the incoming state is different from what we have applied
                    if (updatedState.id !== this.canonicalHeightRecordId || updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`Received updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.canonicalHeightRecordId = updatedState.id; // Update ID just in case
                        this.applyHeightState(updatedState); // Apply the full state
                        // Ensure geometry reflects the update
                        this.geometry.attributes.position.needsUpdate = true;
                        this.geometry.computeVertexNormals();
                    }
                } else {
                    // Handle case where the state might have been deleted?
                    console.warn("Canonical height state subscription returned empty list.");
                    // Perhaps reset to flat or handle as appropriate
                    // await this.createFlatTerrainStateRecord();
                }
            });

            console.log("Terrain height state loading process complete.");

        } catch (error) {
            console.error('Error loading terrain height state:', error);
            // Fallback: ensure terrain is at least flat locally
            this.applyHeightState({ heightData: {} }); // Apply empty data to ensure reset potentially
        } finally {
            this.isLoading = false; // Mark loading as complete
            // Ensure geometry is updated visually after loading attempt
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('Invalid height state data:', stateData);
            // Ensure terrain is reset to flat if data is bad
            stateData = { heightData: {} }; // Use default empty data
        }
        // Avoid re-applying the same state received via subscription
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            // console.log("Skipping application of already current height state.");
            return false;
        }

        console.log("Applying canonical height state...");
        const positions = this.geometry.attributes.position;
        let applied = false;
        // Directly replace local state with the loaded state data
        this.terrainHeightData = { ...stateData.heightData };

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const height = this.terrainHeightData[i] !== undefined ? Number(this.terrainHeightData[i]) : 0; // Default to 0 height
            positions.setY(i, height);
            // Ensure local cache reflects the applied state (including defaults)
            this.terrainHeightData[i] = height;
            applied = true; // Mark if any vertex was processed
        }

        if (applied) {
            console.log('Applied canonical height state data to terrain geometry.');
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        } else {
            console.warn('No valid height data found in state record, terrain may be flat.');
        }
        // Caller should handle needsUpdate and computeVertexNormals typically
        return applied;
    }

    // Called during mouse drag to stage changes for the current stroke
    accumulateHeightChange(index, newHeight) {
        // Store the latest height for this vertex within the current stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }

    // Save the *entire current* height state by updating the canonical record
    async saveTerrainChanges() {
        // Merge changes from the current stroke into the main state
        if (Object.keys(this.currentStrokeHeightChanges).length > 0) {
            this.terrainHeightData = { ...this.terrainHeightData, ...this.currentStrokeHeightChanges };
            this.currentStrokeHeightChanges = {}; // Reset stroke changes
        } else {
            console.log("No height changes in current stroke to save.");
            return; // No need to save if nothing changed in the stroke
        }

        // Prevent saving during initial load or if no data exists
        if (this.isLoading || Object.keys(this.terrainHeightData).length === 0) {
            console.log("Skipping save: Still loading or no height data.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving height...');

            const saveData = {
                heightData: this.terrainHeightData,
                vertexCount: this.geometry.attributes.position.count,
                timestamp: new Date().toISOString() // Use timestamp to track updates
            };

            if (this.canonicalHeightRecordId) {
                // Update the existing canonical record
                await this.room.collection('terrainHeightState').update(this.canonicalHeightRecordId, saveData);
                console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId}`);
            } else {
                // Create the first canonical record if it doesn't exist yet
                console.log("Canonical height record ID not found, creating new one...");
                const newRecord = await this.room.collection('terrainHeightState').create(saveData);
                this.canonicalHeightRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = saveData.timestamp; // Set timestamp for the newly created record
                console.log(`Created canonical height state record: ${this.canonicalHeightRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving terrain height state:', error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Consider how to handle errors
        } finally {
            this.currentStrokeHeightChanges = {}; // Always clear stroke changes after attempt
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

            const saveData = {
                heightData: heightData,
                vertexCount: positions.count,
                isInitial: true,
                timestamp: new Date().toISOString()
            };

            // Save the initial state record
            const stateRecord = await this.room.collection('terrainHeightState').create(saveData);
            this.canonicalHeightRecordId = stateRecord.id; // Store the ID of the created record
            this.lastAppliedTimestamp = saveData.timestamp; // Track its timestamp
            console.log('Created and saved initial flat terrain state record:', this.canonicalHeightRecordId);
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