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
        // Track the timestamp of the currently applied height data to avoid loops/stale updates
        this.lastAppliedTimestamp = null;
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke before merging into terrainHeightData
        this.currentStrokeHeightChanges = {};
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        // Define the specific collection name for the canonical height state
        this.collectionName = 'terrainHeightState_canonical_v1'; // Changed name
    }

    async loadTerrainData() {
        this.isLoading = true;
        try {
            console.log(`Loading canonical terrain height state from collection: ${this.collectionName}...`);
            const positions = this.geometry.attributes.position;

            // Fetch the list of state records. Expecting only one.
            const states = await this.room.collection(this.collectionName).getList(); // Use synchronous getList initially

            if (states.length > 0) {
                // The newest (and ideally only) record is the first one
                const latestState = states[0];
                this.canonicalHeightRecordId = latestState.id; // Store the ID
                console.log(`Found existing height state record: ${this.canonicalHeightRecordId}. Applying...`);
                this.applyHeightState(latestState); // Apply the found state
            } else {
                console.log("No canonical terrain height state found. Creating initial flat terrain state.");
                // If no state exists, initialize geometry to flat and create the first record
                await this.createFlatTerrainStateRecord(); // This sets geometry, saves the first state, and sets the ID/timestamp
            }

            // Subscribe to future updates of the canonical state record
            this.room.collection(this.collectionName).subscribe((incomingStates) => {
                if (this.isLoading) {
                    // console.log("Skipping subscription update during initial load.");
                    return; // Don't process subscription updates while still loading initial state
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates[0]; // Get the latest/only record

                    // Only apply if it's the record we know (or should know) and the timestamp is newer
                    if (updatedState.id === this.canonicalHeightRecordId && updatedState.timestamp > this.lastAppliedTimestamp) {
                        console.log(`Received updated height state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.applyHeightState(updatedState); // Apply the full state
                        // Ensure geometry reflects the update
                        this.geometry.attributes.position.needsUpdate = true;
                        this.geometry.computeVertexNormals();
                    } else if (updatedState.id !== this.canonicalHeightRecordId) {
                        console.warn(`Subscription received state with unexpected ID ${updatedState.id}, expected ${this.canonicalHeightRecordId}. Ignoring.`);
                    } else {
                        // Timestamp is not newer, likely our own change echoing back or already applied
                        // console.log(`Subscription update ignored: Timestamp ${updatedState.timestamp} not newer than ${this.lastAppliedTimestamp}`);
                    }
                } else {
                    // Handle case where the canonical state might have been deleted?
                    console.warn(`Canonical height state subscription returned empty list for ${this.collectionName}. State might be lost.`);
                    // Optionally, recreate the flat state record here.
                    // await this.createFlatTerrainStateRecord();
                }
            });

            console.log("Terrain height state loading process complete.");

        } catch (error) {
            console.error(`Error loading terrain height state from ${this.collectionName}:`, error);
            // Fallback: ensure terrain is at least flat locally
            this.applyHeightState({ heightData: {}, timestamp: null }); // Apply empty data to ensure reset
        } finally {
            // Ensure geometry is updated visually after loading attempt
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.computeVertexNormals();
            // Allow processing subscription updates after a short delay to ensure initial load completes
            setTimeout(() => { this.isLoading = false; }, 500);
        }
    }

    // Apply a full height data map (from the canonical state record)
    applyHeightState(stateData) {
        if (!stateData || typeof stateData.heightData !== 'object' || !stateData.timestamp) {
            console.warn('Invalid or incomplete height state data received:', stateData);
            return false; // Don't apply invalid data
        }

        // Avoid re-applying the same state based on timestamp
        if (stateData.timestamp === this.lastAppliedTimestamp) {
            // console.log(`Skipping application of height state with timestamp ${stateData.timestamp} as it's already applied.`);
            return false;
        }
        // Prevent applying older states than the one we currently have
        if (this.lastAppliedTimestamp && stateData.timestamp < this.lastAppliedTimestamp) {
            console.log(`Skipping application of older height state (received ${stateData.timestamp}, have ${this.lastAppliedTimestamp}).`);
            return false;
        }

        console.log(`Applying canonical height state (TS: ${stateData.timestamp})...`);
        const positions = this.geometry.attributes.position;
        let applied = false;
        // Directly replace local state with the loaded state data
        this.terrainHeightData = { ...stateData.heightData }; // Use spread to ensure a copy

        // Apply heights from state, default to 0 if index missing in the data
        for (let i = 0; i < positions.count; i++) {
            // Check if index exists in stateData.heightData, otherwise default to 0
            const height = stateData.heightData[i] !== undefined ? Number(stateData.heightData[i]) : 0;
            positions.setY(i, height);
            // Ensure local cache reflects exactly what was applied (including defaults)
            this.terrainHeightData[i] = height;
            applied = true;
        }

        if (applied) {
            console.log('Applied canonical height state data to terrain geometry.');
            this.lastAppliedTimestamp = stateData.timestamp; // Update timestamp of applied data
            // The ID should already be set if we loaded an existing record
            if (!this.canonicalHeightRecordId && stateData.id) {
                this.canonicalHeightRecordId = stateData.id;
                console.log(`Canonical height record ID set to ${this.canonicalHeightRecordId} during apply.`);
            }
        } else {
            console.warn('No vertices processed during height state application.');
        }
        // Caller should handle needsUpdate and computeVertexNormals typically
        return applied;
    }

    accumulateHeightChange(index, newHeight) {
        // Store the latest height for this vertex within the current stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }

    // Save the *entire current* height state by updating the canonical record
    async saveTerrainChanges() {
        // Merge changes from the current stroke into the main state representation
        if (Object.keys(this.currentStrokeHeightChanges).length > 0) {
            // Update the main height data object with the changes from the stroke
            Object.assign(this.terrainHeightData, this.currentStrokeHeightChanges);
            this.currentStrokeHeightChanges = {}; // Reset stroke changes after merging
        } else {
            // console.log("No height changes in current stroke to save.");
            return; // No need to save if nothing changed in the stroke
        }

        // Prevent saving if we don't have the canonical record ID (should only happen briefly on init)
        if (!this.canonicalHeightRecordId) {
            console.warn("Cannot save terrain height: Canonical record ID not yet established.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving height...');

            const newTimestamp = new Date().toISOString();
            const saveData = {
                heightData: this.terrainHeightData, // Save the complete, merged state
                vertexCount: this.geometry.attributes.position.count,
                timestamp: newTimestamp // Update timestamp to mark this version
            };

            // Update the single canonical record using its known ID
            await this.room.collection(this.collectionName).update(this.canonicalHeightRecordId, saveData);
            // Immediately update the local timestamp to prevent re-applying our own change from subscription
            this.lastAppliedTimestamp = newTimestamp;
            console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId} with TS: ${newTimestamp}`);

            this.showSaveStatus(false);

        } catch (error) {
            console.error(`Error saving terrain height state to ${this.collectionName} (ID: ${this.canonicalHeightRecordId}):`, error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Consider error handling: maybe revert local terrainHeightData if save failed?
        } finally {
            this.currentStrokeHeightChanges = {}; // Ensure stroke changes are cleared even if save failed
        }
    }

    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        try {
            console.log(`Creating initial flat terrain state record in ${this.collectionName}...`);
            const positions = this.geometry.attributes.position;
            const initialHeightData = {};
            this.terrainHeightData = {}; // Reset local cache

            for (let i = 0; i < positions.count; i++) {
                initialHeightData[i] = 0;
                positions.setY(i, 0); // Set geometry flat
                this.terrainHeightData[i] = 0; // Update local cache
            }
            // Geometry updates (needsUpdate, normals) handled by caller (loadTerrainData)

            const initialTimestamp = new Date().toISOString();
            const saveData = {
                heightData: initialHeightData,
                vertexCount: positions.count,
                isInitial: true,
                timestamp: initialTimestamp
            };

            // Create the first and only record for this state type
            const stateRecord = await this.room.collection(this.collectionName).create(saveData);
            this.canonicalHeightRecordId = stateRecord.id; // Store the ID of the created record
            this.lastAppliedTimestamp = initialTimestamp; // Track its timestamp immediately
            console.log(`Created and saved initial flat terrain height state record: ${this.canonicalHeightRecordId}`);

            // No need to return heightData, applyHeightState handles the local geometry

        } catch (error) {
            console.error(`Error creating flat terrain state record in ${this.collectionName}:`, error);
            this.canonicalHeightRecordId = null; // Ensure ID is null if creation failed
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