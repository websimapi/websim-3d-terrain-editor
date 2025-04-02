import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        // Tracks changes made *during* the current paint stroke
        this.currentStrokeColorChanges = {};
        // Represents the fully loaded/merged color state of the terrain
        this.terrainColors = {}; // Stores { vertexIndex: hexColorString }
        this.statusElement = document.getElementById('save-status');
        this.colorPalette = [
            { hex: '#66aa66', name: 'Grass Green' },
            { hex: '#228B22', name: 'Forest Green' },
            { hex: '#8B4513', name: 'Brown' },
            { hex: '#A0522D', name: 'Sienna' },
            { hex: '#C2B280', name: 'Sand' },
            { hex: '#F5DEB3', name: 'Wheat' },
            { hex: '#7393B3', name: 'Blue Gray' },
            { hex: '#FFFFFF', name: 'Snow' },
            { hex: '#808080', name: 'Gray' },
            { hex: '#2F4F4F', name: 'Dark Slate' },
            { hex: '#000000', name: 'Black' },
            { hex: '#8A9A5B', name: 'Moss Green' }
        ];
        this.currentColor = this.colorPalette[0].hex;
        // Track applied changes to prevent re-applying from subscription
        this.processedColorChangeIds = new Set();
        this.changesSinceSnapshot = 0;
        this.SNAPSHOT_THRESHOLD = 10; // Create snapshot every N changes
    }

    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; // Clear any existing swatches

        this.colorPalette.forEach(color => {
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color.hex;
            swatch.title = color.name;
            swatch.dataset.color = color.hex;

            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }

            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                this.currentColor = color.hex;
                const event = new CustomEvent('colorChanged', {
                    detail: {
                        color: this.currentColor,
                        name: color.name
                    }
                });
                document.dispatchEvent(event);
            });

            swatchesContainer.appendChild(swatch);
        });
    }

    ensureColorAttribute() {
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with a default base color (e.g., Grass Green)
            const defaultColor = new THREE.Color(this.colorPalette[0].hex);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        }
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();

        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const targetColor = new THREE.Color(this.currentColor);

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const blendFactor = falloff * (brushStrength / 5); // Strength adjustment

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);

                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke
                this.currentStrokeColorChanges[i] = '#' + existingColor.getHexString();

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true; // Indicate that the geometry was modified
        }
        return false;
    }

    // Save the accumulated changes from the current stroke
    async saveColorChanges() {
        if (Object.keys(this.currentStrokeColorChanges).length === 0) return;

        try {
            this.showSaveStatus(true);
            const changesToSave = { ...this.currentStrokeColorChanges };
            const changeCount = Object.keys(changesToSave).length;

            // Update the main terrainColors state immediately for local consistency
            this.terrainColors = { ...this.terrainColors, ...changesToSave };

            // Create an incremental change record
            const changeRecord = await this.room.collection('terrainColorChange').create({
                colorChanges: changesToSave,
                changeCount: changeCount,
                timestamp: new Date().toISOString()
            });
            this.processedColorChangeIds.add(changeRecord.id); // Mark as processed locally

            // Reset stroke changes
            this.currentStrokeColorChanges = {};
            this.changesSinceSnapshot++;

            // Periodically create a full snapshot
            if (this.changesSinceSnapshot >= this.SNAPSHOT_THRESHOLD) {
                await this.createFullColorSnapshot();
                this.changesSinceSnapshot = 0; // Reset counter
            }

            this.showSaveStatus(false);
            console.log(`Saved ${changeCount} color changes.`);

        } catch (error) {
            console.error('Error saving color changes:', error);
            this.showSaveStatus(false, true);
            // Optionally revert local state or handle error
            this.currentStrokeColorChanges = {}; // Clear changes on error too
        }
    }

    // Applies a full color map (from a snapshot)
    applyColorSnapshot(snapshotData) {
        if (!snapshotData || typeof snapshotData !== 'object') {
            console.error('Invalid color snapshot data:', snapshotData);
            return false;
        }
        console.log("Applying color snapshot...");
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        let applied = false;
        this.terrainColors = { ...snapshotData }; // Replace local state with snapshot

        for (const [vertexIndex, colorHex] of Object.entries(snapshotData)) {
            const i = parseInt(vertexIndex);
            if (isNaN(i) || i < 0 || i >= colorAttribute.count) continue;
            try {
                const color = new THREE.Color(colorHex);
                colorAttribute.setXYZ(i, color.r, color.g, color.b);
                applied = true;
            } catch (e) {
                console.warn(`Invalid color hex ${colorHex} at index ${i} in snapshot.`);
            }
        }

        if (applied) {
            colorAttribute.needsUpdate = true;
            console.log('Applied color snapshot to terrain geometry.');
        } else {
            console.warn('No valid color data found in snapshot to apply.');
        }
        return applied;
    }

    // Applies incremental color changes
    applyIncrementalColorChanges(changeRecords) {
        if (!changeRecords || changeRecords.length === 0) return;

        console.log(`Applying ${changeRecords.length} incremental color changes.`);
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        let modified = false;

        // Sort changes chronologically before applying
        changeRecords.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        changeRecords.forEach(record => {
            if (!record.colorChanges || typeof record.colorChanges !== 'object') {
                console.warn('Skipping invalid color change record:', record.id);
                return;
            }
            if (this.processedColorChangeIds.has(record.id)) {
                // console.log('Skipping already processed color change:', record.id);
                return; // Already processed
            }

            for (const [vertexIndex, colorHex] of Object.entries(record.colorChanges)) {
                const i = parseInt(vertexIndex);
                if (isNaN(i) || i < 0 || i >= colorAttribute.count) continue;
                try {
                    const color = new THREE.Color(colorHex);
                    colorAttribute.setXYZ(i, color.r, color.g, color.b);
                    // Update the main color state as well
                    this.terrainColors[i] = colorHex;
                    modified = true;
                } catch (e) {
                    console.warn(`Invalid color hex ${colorHex} at index ${i} in change ${record.id}.`);
                }
            }
            this.processedColorChangeIds.add(record.id); // Mark as processed
        });

        if (modified) {
            colorAttribute.needsUpdate = true;
            console.log('Applied incremental color changes to geometry.');
        }
    }

    // Load initial color state from database (snapshot + changes)
    async loadColorData() {
        try {
            console.log("Loading color data...");
            this.ensureColorAttribute(); // Make sure attribute exists before loading

            // 1. Fetch the latest snapshot
            const snapshots = await this.room.collection('terrainColorSnapshot').getList();
            let latestSnapshot = null;
            let snapshotTime = null;
            if (snapshots.length > 0) {
                latestSnapshot = snapshots.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                snapshotTime = new Date(latestSnapshot.created_at);
                console.log('Applying color snapshot from:', snapshotTime);
                this.applyColorSnapshot(latestSnapshot.colorData);
                this.processedColorChangeIds.add(latestSnapshot.id); // Consider snapshot processed
            } else {
                console.log("No color snapshot found. Starting with default colors.");
                // Initialize terrainColors with default if no snapshot
                this.initializeDefaultColors();
            }

            // 2. Fetch incremental changes made *after* the snapshot
            const allChanges = await this.room.collection('terrainColorChange').getList();
            let changesToApply = allChanges;
            if (snapshotTime) {
                console.log(`Filtering ${allChanges.length} changes after snapshot time ${snapshotTime.toISOString()}`);
                changesToApply = allChanges.filter(change => {
                    const changeTime = new Date(change.created_at);
                    return changeTime > snapshotTime && !this.processedColorChangeIds.has(change.id);
                });
            } else {
                // If no snapshot, apply all changes we haven't processed
                changesToApply = allChanges.filter(change => !this.processedColorChangeIds.has(change.id));
            }


            if (changesToApply.length > 0) {
                console.log(`Found ${changesToApply.length} incremental color changes to apply.`);
                this.applyIncrementalColorChanges(changesToApply);
            } else {
                console.log("No new incremental color changes found after snapshot (or no snapshot).");
            }


            // 3. Subscribe to future incremental changes
            this.room.collection('terrainColorChange').subscribe((incomingChanges) => {
                const newChanges = incomingChanges.filter(change => !this.processedColorChangeIds.has(change.id));
                if (newChanges.length > 0) {
                    console.log(`Received ${newChanges.length} new color changes via subscription.`);
                    this.applyIncrementalColorChanges(newChanges);
                }
            });

            console.log("Color data loading process complete.");

        } catch (error) {
            console.error('Error loading color data:', error);
        }
    }

    // Helper to set default colors if no data is loaded
    initializeDefaultColors() {
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use first palette color
        this.terrainColors = {}; // Reset local state
        for (let i = 0; i < colorAttribute.count; i++) {
            colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            this.terrainColors[i] = this.colorPalette[0].hex;
        }
        colorAttribute.needsUpdate = true;
        console.log("Initialized terrain with default colors.");
    }

    // Create a snapshot of the current full color state
    async createFullColorSnapshot() {
        try {
            console.log("Creating full color snapshot...");
            // Ensure terrainColors is up-to-date (should be handled by apply methods)
            if (Object.keys(this.terrainColors).length === 0) {
                console.warn("Skipping color snapshot: No color data available.");
                return;
            }

            await this.room.collection('terrainColorSnapshot').create({
                colorData: this.terrainColors, // Save the complete current state
                vertexCount: Object.keys(this.terrainColors).length,
                timestamp: new Date().toISOString()
            });
            console.log('Successfully created new color snapshot.');

            // Optional: Clean up old incremental changes (Advanced - requires care)
            // await this.cleanupOldChanges(new Date()); // Pass snapshot time

        } catch (error) {
            console.error('Error creating color snapshot:', error);
        }
    }

    // --- Optional Cleanup Logic (Example - Use with caution) ---
    // async cleanupOldChanges(snapshotTime) {
    //     console.log("Attempting cleanup of old color changes before:", snapshotTime);
    //     const changes = await this.room.collection('terrainColorChange').getList();
    //     const changesToDelete = changes.filter(c => new Date(c.created_at) < snapshotTime && c.username === this.room.peers[this.room.clientId].username);

    //     if (changesToDelete.length > 0) {
    //         console.log(`Found ${changesToDelete.length} old color changes to delete.`);
    //         for (const change of changesToDelete) {
    //             try {
    //                 // IMPORTANT: You can only delete your own records!
    //                 await this.room.collection('terrainColorChange').delete(change.id);
    //                 console.log(`Deleted old color change: ${change.id}`);
    //                 this.processedColorChangeIds.delete(change.id); // Remove from local cache if present
    //             } catch (error) {
    //                 console.error(`Failed to delete old color change ${change.id}:`, error);
    //                 // If deletion fails (e.g., not owner), stop trying for this record.
    //             }
    //         }
    //     } else {
    //         console.log("No old color changes found for cleanup.");
    //     }
    // }


    // Show save status indicator
    showSaveStatus(isVisible, isError = false) {
        if (!this.statusElement) return;
        this.statusElement.textContent = isError ? 'Error saving color!' : 'Saving color...';
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            // Automatically hide after a short delay
            setTimeout(() => {
                if (this.statusElement.textContent === 'Saving color...') {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}