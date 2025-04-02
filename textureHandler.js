import * as THREE from 'three';
import { ImageProxy } from './proxy.js';

export class TextureHandler {
    constructor() {
        this.textureCache = new Map();
        this.imageProxy = new ImageProxy();
        this.loadingTextures = new Map(); // Track textures being loaded to prevent duplicate requests
    }

    isTextureUrl(value) {
        return this.imageProxy.isImageUrl(value);
    }

    async loadTexture(url) {
        // Return cached texture if available
        if (this.textureCache.has(url)) {
            return this.textureCache.get(url);
        }
        
        // If already loading this texture, return the existing promise
        if (this.loadingTextures.has(url)) {
            return this.loadingTextures.get(url);
        }
        
        // Create and store the loading promise
        const texturePromise = this._loadTextureWithRetry(url);
        this.loadingTextures.set(url, texturePromise);
        
        try {
            // Wait for loading to complete
            const texture = await texturePromise;
            // Cache the successful result
            this.textureCache.set(url, texture);
            // Remove from loading tracker
            this.loadingTextures.delete(url);
            return texture;
        } catch (error) {
            // Remove from loading tracker on error
            this.loadingTextures.delete(url);
            throw error;
        }
    }
    
    async _loadTextureWithRetry(originalUrl) {
        let errors = [];
        // Try direct load first for data URLs and same-origin URLs
        if (originalUrl.startsWith('data:') || originalUrl.includes('.websim.ai/')) {
            try {
                return await this._loadTextureDirectly(originalUrl);
            } catch (error) {
                errors.push(`Direct load failed: ${error.message}`);
                // Fall through to proxy method if not a data URL
                if (originalUrl.startsWith('data:')) {
                    throw new Error(`Failed to load data URL: ${errors.join(', ')}`);
                }
            }
        }
        
        try {
            // Get a proxied URL to avoid CORS issues
            const proxiedUrl = await this.imageProxy.getProxiedUrl(originalUrl);
            return await this._loadTextureDirectly(proxiedUrl);
        } catch (error) {
            errors.push(`Proxied load failed: ${error.message}`);
            
            // As last resort, try creating a fallback colored texture
            console.warn(`Texture loading failed for ${originalUrl}, using fallback color texture`);
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#888888';
            ctx.fillRect(0, 0, 64, 64);
            
            const texture = new THREE.CanvasTexture(canvas);
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            return texture;
        }
    }
    
    _loadTextureDirectly(url) {
        return new Promise((resolve, reject) => {
            const loader = new THREE.TextureLoader();
            loader.load(
                url,
                (texture) => {
                    texture.wrapS = THREE.RepeatWrapping;
                    texture.wrapT = THREE.RepeatWrapping;
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
            }).catch(err => {
                console.error("Error loading texture:", err);
                // Reset to a default color on error
                material.color.set(0x888888);
                if (material.map) {
                    material.map.dispose();
                    material.map = null;
                }
                material.needsUpdate = true;
            });
            return true;
        } else {
            try {
                if (material.map) {
                    material.map.dispose();
                    material.map = null;
                }
                material.color.copy(result.color);
                material.needsUpdate = true;
            } catch (err) {
                console.error("Error setting color:", err);
                material.color.set(0x888888); // Default gray on error
            }
            return false; // Not a texture
        }
    }
}