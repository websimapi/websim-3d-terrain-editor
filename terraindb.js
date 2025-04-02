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
        this.myUsername = ''; // Set in initialize (if needed)
        this.statusElement = document.getElementById('save-status');
        // Stores changes during the current stroke before merging into terrainHeightData
        this.currentStrokeHeightChanges = {};
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        // Flag to track if initial state has been loaded/applied
        this.initialDataLoaded = false;
        this.unsubscribeHeight = null; // To store unsubscribe function
        this.initialLoadTimeout = null; // Timeout handle
        this.COLLECTION_NAME = 'terrainHeightState'; // Constant for collection name
    }

    async loadTerrainData() {
        console.log(`Initiating ${this.COLLECTION_NAME} loading...`);
        this.isLoading = true;
        this.initialDataLoaded = false;
        this.canonicalHeightRecordId = null;
        this.lastAppliedTimestamp = null;
        if (this.unsubscribeHeight) this.unsubscribeHeight();
        if (this.initialLoadTimeout) clearTimeout(this.initialLoadTimeout);

        console.log(`Subscribing to ${this.COLLECTION_NAME} collection...`);
        this.unsubscribeHeight = this.room.collection(this.COLLECTION_NAME).subscribe(async (states) => {
            console.log(`${this.COLLECTION_NAME} subscription triggered. Received ${states.length} states. Initial load done: ${this.initialDataLoaded}`);
            if (this.initialLoadTimeout) clearTimeout(this.initialLoadTimeout); // Clear timeout if subscription fires

            if (!this.initialDataLoaded) {
                // First data received from subscription
                this.initialDataLoaded = true; // Mark that we received *something* (even empty)
                if (states.length > 0) {
                    // Find the canonical state (newest)
                     // Filter out potentially malformed states first
                    const validStates = states.filter(s => s.heightData && typeof s.heightData === 'object');
                    if (validStates.length === 0) {
                         console.warn(`${this.COLLECTION_NAME}: Subscription provided states, but none were valid. Creating default.`);
                         await this.handleInitialLoadFailure(); // Create default record
                         return; // Exit callback for this state list
                    }

                    const latestState = validStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`Applying initial canonical ${this.COLLECTION_NAME} state: ID=${latestState.id}, TS=${latestState.timestamp}`);
                    this.applyHeightState(latestState); // Apply it (this sets canonical ID and timestamp)
                    this.isLoading = false; // Allow saving now
                } else {
                    // Subscription fired but was empty - means no records exist. Create default.
                    console.log(`Initial subscription for ${this.COLLECTION_NAME} returned empty. Creating default record.`);
                    await this.handleInitialLoadFailure(); // Create default record
                }
                console.log(`${this.COLLECTION_NAME} initial load processing finished. isLoading: ${this.isLoading}`);
                // Ensure geometry update after initial load/creation attempt
                this.geometry.attributes.position.needsUpdate = true;
                this.geometry.computeVertexNormals();
            } else {
                // Update received after initial load
                 if (states.length > 0) {
                    const validStates = states.filter(s => s.heightData && typeof s.heightData === 'object');
                     if (validStates.length === 0) {
                         console.warn(`${this.COLLECTION_NAME}: Update subscription provided states, but none were valid.`);
                         return;
                     }
                    const updatedState = validStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`Processing ${this.COLLECTION_NAME} update: ID=${updatedState.id}, Timestamp=${updatedState.timestamp}, CurrentCanonicalID=${this.canonicalHeightRecordId}, LastAppliedTS=${this.lastAppliedTimestamp}`);

                     // Apply if it's a new state (different timestamp) for the canonical record OR if the canonical ID somehow changed
                    if (updatedState.id === this.canonicalHeightRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`Applying updated ${this.COLLECTION_NAME} state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                        if(this.applyHeightState(updatedState)) {
                            this.geometry.attributes.position.needsUpdate = true;
                            this.geometry.computeVertexNormals();
                            console.log(`Geometry height updated from ${this.COLLECTION_NAME} subscription.`);
                        }
                    } else if (updatedState.id !== this.canonicalHeightRecordId) {
                        console.warn(`Canonical ${this.COLLECTION_NAME} record ID changed from ${this.canonicalHeightRecordId} to ${updatedState.id}. Applying new state.`);
                        if(this.applyHeightState(updatedState)) { // applyState handles setting new canonical ID
                             this.geometry.attributes.position.needsUpdate = true;
                             this.geometry.computeVertexNormals();
                            console.log(`Geometry height updated from new canonical ${this.COLLECTION_NAME} ID.`);
                        }
                    } else {
                         console.log(`Skipping ${this.COLLECTION_NAME} update: Same timestamp or non-canonical ID.`);
                    }
                } else {
                     console.warn(`Canonical ${this.COLLECTION_NAME} subscription returned empty list after initial load. Record might be deleted.`);
                     this.canonicalHeightRecordId = null; // Clear the ID
                     this.lastAppliedTimestamp = null;
                     // Optionally reset to flat terrain here? Or wait for user action.
                     // this.applyHeightState({ heightData: {}, timestamp: null });
                }
            }
        });

        // Helper function for handling initial load failure (no records found)
        const handleInitialLoadFailure = async () => {
            try {
                await this.createFlatTerrainStateRecord(); // Create and save the first record
                console.log(`Default ${this.COLLECTION_NAME} record created successfully.`);
            } catch (creationError) {
                console.error(`Failed to create initial ${this.COLLECTION_NAME} record`, creationError);
                this.applyHeightState({ heightData: {}, timestamp: null }); // Apply flat locally as fallback
            } finally {
                this.isLoading = false; // Allow saving/interaction even if creation failed
            }
        };


        // Timeout as a fallback in case subscription doesn't fire quickly
        this.initialLoadTimeout = setTimeout(async () => {
             console.log(`${this.COLLECTION_NAME}: Checking initial load status after timeout.`);
            if (!this.initialDataLoaded) {
                console.warn(`${this.COLLECTION_NAME}: Initial data not received via subscription after timeout. Attempting to create default record.`);
                 this.initialDataLoaded = true; // Mark as handled (attempted)
                 await handleInitialLoadFailure(); // Use the same failure handler
                 // Ensure geometry update after timeout handler
                 this.geometry.attributes.position.needsUpdate = true;
                 this.geometry.computeVertexNormals();
            }
        }, 5000); // 5 second timeout
    }


    applyHeightState(stateData) {
        console.log(`Attempting to apply height state. Incoming ID: ${stateData?.id}, TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.heightData !== 'object') {
            console.warn('Invalid height state data received:', stateData);
            stateData = { heightData: {}, timestamp: null }; // Use default empty data for reset
        }

        // Avoid re-applying the same state received via subscription or initial load
        // Allow applying if canonical ID has changed even if timestamp is same (edge case)
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp && stateData.id === this.canonicalHeightRecordId) {
             console.log(`Skipping application of height state: Timestamp ${stateData.timestamp} already applied for ID ${stateData.id}.`);
            return false; // Indicate no change was made
        }

        const stateIdForLog = stateData.id || '(local default)';
        console.log(`Applying canonical height state (ID: ${stateIdForLog}, TS: ${stateData.timestamp})...`);
        const positions = this.geometry.attributes.position;
        const loadedHeightData = stateData.heightData || {};
        const numLoadedKeys = Object.keys(loadedHeightData).length;
        console.log(`State contains ${numLoadedKeys} height entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;

        // Clear current local state before applying the new one
        this.terrainHeightData = {};

        // Apply heights from state, default to 0 if index missing
        for (let i = 0; i < positions.count; i++) {
            const loadedHeight = loadedHeightData[i];
            // Ensure height is a number, default to 0 if invalid or missing
            const height = (loadedHeight !== undefined && loadedHeight !== null && !isNaN(Number(loadedHeight))) ? Number(loadedHeight) : 0;

            positions.setY(i, height); // Apply directly

            // Ensure local cache reflects the applied state (including defaults)
            this.terrainHeightData[i] = height;

            if (loadedHeight !== undefined && loadedHeight !== null && !isNaN(Number(loadedHeight))) {
                verticesApplied++;
            } else {
                 if(loadedHeight !== undefined && loadedHeight !== null) { // Log if it existed but was invalid
                     console.warn(`Invalid height value '${loadedHeight}' at index ${i}. Defaulting to 0.`);
                 }
                verticesDefaulted++;
            }
        }

        console.log(`Applied height state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to 0.`);
         if (stateData.timestamp) {
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        }
         // If applying state from a record, update the canonical ID
         if (stateData.id) {
            this.canonicalHeightRecordId = stateData.id;
         }
        // Caller handles geometry updates (needsUpdate, computeVertexNormals)
        return true; // Indicate that state was applied
    }

    accumulateHeightChange(index, newHeight) {
        // Store the latest height for this vertex within the current stroke
        this.currentStrokeHeightChanges[index] = newHeight;
    }

    async saveTerrainChanges() {
        // Prevent saving during initial load OR if initial data hasn't been confirmed yet
         if (this.isLoading || !this.initialDataLoaded) {
             console.log("Skipping height save: Still loading or initial data not confirmed.");
             return;
         }
        // Merge changes from the current stroke into the main state BEFORE checking if empty
        let changesFromStroke = Object.keys(this.currentStrokeHeightChanges).length > 0;
        if (changesFromStroke) {
             console.log(`Merging ${Object.keys(this.currentStrokeHeightChanges).length} height changes from stroke into canonical state.`);
            this.terrainHeightData = { ...this.terrainHeightData, ...this.currentStrokeHeightChanges };
            this.currentStrokeHeightChanges = {}; // Reset stroke changes
        } else {
            console.log("No height changes accumulated in the current stroke.");
            return;
        }

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
                 try {
                    await this.room.collection(this.COLLECTION_NAME).update(this.canonicalHeightRecordId, saveData);
                    console.log(`Updated canonical height state record: ${this.canonicalHeightRecordId}`);
                    this.lastAppliedTimestamp = currentTimestamp; // Update timestamp only on successful update
                 } catch(updateError) {
                     console.error(`Failed to update height record ${this.canonicalHeightRecordId}, attempting to create new. Error:`, updateError);
                      // If update failed (e.g., record deleted), try creating a new one
                     await this.createCanonicalRecord(saveData); // Use the same data
                 }
            } else {
                // Create the first canonical record (or replacement)
                console.log("Canonical height record ID not found or update failed, creating new one...");
                await this.createCanonicalRecord(saveData);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving terrain height state:', error);
            this.showSaveStatus(false, 'Error saving height!', true);
            // Reset stroke changes even on error to avoid resaving failed data
            this.currentStrokeHeightChanges = {};
        } finally {
            // Ensure stroke changes are cleared AFTER the attempt (success or fail)
            this.currentStrokeHeightChanges = {};
        }
    }

    // Helper to create the canonical record and set state
    async createCanonicalRecord(saveData) {
         const newRecord = await this.room.collection(this.COLLECTION_NAME).create(saveData);
         this.canonicalHeightRecordId = newRecord.id; // Store the new ID
         this.lastAppliedTimestamp = saveData.timestamp; // Set timestamp for the newly created record
         console.log(`Created/Replaced canonical ${this.COLLECTION_NAME} record: ${this.canonicalHeightRecordId}`);
          // Ensure initial load flag is set if this happens very early
         if (!this.initialDataLoaded) {
            this.initialDataLoaded = true;
            this.isLoading = false;
         }
    }


    // Create the initial flat terrain state record if none exists
    async createFlatTerrainStateRecord() {
        console.log(`Creating initial flat ${this.COLLECTION_NAME} record...`);
        const positions = this.geometry.attributes.position;
        const heightData = {};
        this.terrainHeightData = {}; // Reset local cache

        for (let i = 0; i < positions.count; i++) {
            heightData[i] = 0;
            positions.setY(i, 0); // Set geometry flat
            this.terrainHeightData[i] = 0; // Update local cache
        }

        // Geometry update (needsUpdate, normals) handled by caller

        const initialTimestamp = new Date().toISOString();
        const saveData = {
            heightData: heightData,
            vertexCount: positions.count,
            isInitial: true,
            timestamp: initialTimestamp
        };

        // Create the canonical record
        await this.createCanonicalRecord(saveData);
         // No need for showSaveStatus here, it's part of initialization
        console.log('Initial flat terrain state record creation complete.');
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