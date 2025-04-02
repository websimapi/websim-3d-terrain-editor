import * as THREE from 'three';

export class TerrainColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.colorChanges = {};
        this.terrainColors = {};
        this.currentColor = '#66aa66'; // Default color
        
        // Color palette configuration
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
    }
    
    initialize() {
        this.initializeColorPalette();
    }
    
    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; // Clear existing swatches
        
        this.colorPalette.forEach(color => {
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color.hex;
            swatch.title = color.name;
            swatch.dataset.color = color.hex;
            
            // Mark the first color as active by default
            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }
            
            swatch.addEventListener('click', (e) => {
                // Prevent brush application when clicking color
                e.stopPropagation();
                
                // Update active swatch
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                
                // Update current color
                this.currentColor = color.hex;
                
                // Notify any subscribers of color change
                if (this.onColorChange) {
                    this.onColorChange(this.currentColor);
                }
            });
            
            swatchesContainer.appendChild(swatch);
        });
    }
    
    ensureColorAttribute() {
        const terrain = this.scene.getObjectByName('terrain');
        if (!terrain) return false;
        
        // Initialize color attribute if it doesn't exist
        if (!this.geometry.attributes.color) {
            const positions = this.geometry.attributes.position;
            const colors = new Float32Array(positions.count * 3);
            
            // Initialize with default terrain color (light green)
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = 0.4;     // R
                colors[i + 1] = 0.6;  // G
                colors[i + 2] = 0.4;  // B
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            
            // Enable vertex colors on the material
            terrain.material.vertexColors = true;
        }
        
        return true;
    }
    
    applyColorToBrush(point, brushRadius, brushStrength) {
        if (!this.ensureColorAttribute()) return false;
        
        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const color = new THREE.Color(this.currentColor);
        
        // Iterate through all vertices
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            
            // Calculate distance in the XZ plane for cylindrical brush effect
            const dx = vertex.x - point.x;
            const dz = vertex.z - point.z;
            const distance = Math.sqrt(dx * dx + dz * dz);
            
            if (distance < brushRadius) {
                // Smoother falloff using cosine function
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                
                // Get existing color
                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                
                // Blend between existing and new color based on falloff and strength
                const blendFactor = falloff * (brushStrength / 5);
                existingColor.lerp(color, blendFactor);
                
                // Apply the color
                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);
                
                // Store the color change for database
                this.colorChanges[i] = '#' + existingColor.getHexString();
                
                colorModified = true;
            }
        }
        
        if (colorModified) {
            colorAttribute.needsUpdate = true;
        }
        
        return colorModified;
    }
    
    // Get accumulated color changes and reset the tracking
    getColorChanges() {
        const changes = {...this.colorChanges};
        this.colorChanges = {};
        return changes;
    }
    
    getCurrentColor() {
        return this.currentColor;
    }
    
    // Apply color data from the database to the terrain
    applyColorDataToTerrain(colorData) {
        if (!colorData || typeof colorData !== 'object') {
            console.error('Invalid color data:', colorData);
            return;
        }
        
        if (!this.ensureColorAttribute()) return;
        
        // Store colors locally
        this.terrainColors = {...this.terrainColors, ...colorData};
        
        // Update colors based on received data
        const colorAttribute = this.geometry.attributes.color;
        let colorModified = false;
        
        for (const [vertexIndex, colorHex] of Object.entries(colorData)) {
            const i = parseInt(vertexIndex);
            if (isNaN(i) || i < 0 || i >= colorAttribute.count) continue;
            
            // Convert hex to RGB (0-1 range)
            const color = new THREE.Color(colorHex);
            colorAttribute.setXYZ(i, color.r, color.g, color.b);
            colorModified = true;
        }
        
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            console.log('Applied color data to terrain');
        }
    }
}