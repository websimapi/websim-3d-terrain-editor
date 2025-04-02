// A utility class to handle CORS issues with external images
export class ImageProxy {
    constructor() {
        this.proxyServices = [
            (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
            (url) => `https://thingproxy.freeboard.io/fetch/${url}`
        ];
        this.cachedProxyUrls = new Map();
    }
    
    async getProxiedUrl(originalUrl) {
        // Return cached URL if we've already processed this one
        if (this.cachedProxyUrls.has(originalUrl)) {
            return this.cachedProxyUrls.get(originalUrl);
        }
        
        // For websim-generated images, try uploading them to websim storage
        if (originalUrl.includes('page-images.websim.ai')) {
            try {
                const response = await fetch(originalUrl);
                const blob = await response.blob();
                const file = new File([blob], 'texture.jpg', { type: 'image/jpeg' });
                const url = await websim.upload(file);
                this.cachedProxyUrls.set(originalUrl, url);
                return url;
            } catch (err) {
                console.log('Failed to upload to websim, trying proxy services:', err);
                // Fall through to proxy services
            }
        }
        
        // Try each proxy service in order
        for (const proxyFn of this.proxyServices) {
            try {
                const proxiedUrl = proxyFn(originalUrl);
                // Test if the proxied URL works
                const response = await fetch(proxiedUrl, { method: 'HEAD' });
                if (response.ok) {
                    this.cachedProxyUrls.set(originalUrl, proxiedUrl);
                    return proxiedUrl;
                }
            } catch (err) {
                console.log(`Proxy service failed: ${err.message}`);
                // Try the next service
            }
        }
        
        // If all proxy services fail, return the original URL as fallback
        console.warn('All proxy services failed, returning original URL');
        return originalUrl;
    }
    
    isImageUrl(url) {
        return typeof url === 'string' && (
            url.startsWith('http://') || 
            url.startsWith('https://') || 
            url.startsWith('data:image')
        );
    }
}