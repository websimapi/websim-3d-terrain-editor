import * as THREE from 'three';

export class TextureHandler {
    constructor() {
        this.textureCache = new Map();
    }

    isTextureUrl(value) {
        return typeof value === 'string' && (
            value.startsWith('http://') || 
            value.startsWith('https://') || 
            value.startsWith('data:image')
        );
    }

    async loadTexture(url) {
        if (this.textureCache.has(url)) {
            return this.textureCache.get(url);
        }

        return new Promise((resolve, reject) => {
            const loader = new THREE.TextureLoader();
            loader.load(
                url,
                (texture) => {
                    this.textureCache.set(url, texture);
                    resolve(texture);
                },
                undefined,
                (error) => reject(error)
            );
        });
    }

    getColorOrTexture(value) {
        if (this.isTextureUrl(value)) {
            return { isTexture: true, url: value };
        } else {
            return { isTexture: false, color: new THREE.Color(value) };
        }
    }

    applyToMaterial(material, value) {
        const result = this.getColorOrTexture(value);
        
        if (result.isTexture) {
            this.loadTexture(result.url).then(texture => {
                if (material.map) material.map.dispose();
                material.map = texture;
                material.color.set(0xFFFFFF); // Reset color to white for textures
                material.needsUpdate = true;
            }).catch(err => console.error("Error loading texture:", err));
            return true;
        } else {
            if (material.map) {
                material.map.dispose();
                material.map = null;
            }
            material.color.copy(result.color);
            material.needsUpdate = true;
            return false; // Not a texture
        }
    }
}

