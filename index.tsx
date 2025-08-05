import React, { useState, useRef, useEffect, useCallback, ChangeEvent, WheelEvent, MouseEvent } from 'react';
import ReactDOM from 'react-dom/client';

const PAN_SPEED = 10;
const ROTATION_SPEED = 2; // degrees

const loadingQuotes = [
    "Reaching into the dark, Retrieving light",
    "Where the pen meets the sword, new worlds are born.",
    "Every map is a story waiting to be told.",
    "Chart the unknown, and it becomes known.",
];

interface Point {
    x: number;
    y: number;
}

interface TransformState {
    position: Point;
    scale: number;
    rotation: number;
}

// --- Database ---
const DB_NAME = 'FictionalWorldMapDB';
const STORE_NAME = 'maps';

interface SavedMap {
    id: number;
    name: string;
    lastOpened?: number;
    position?: Point;
    scale?: number;
    rotation?: number;
}

interface SavedMapRecord extends SavedMap {
    content: string;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
class MapDatabase {
    private dbPromise: Promise<IDBDatabase>;

    constructor() {
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject("Error opening DB");
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                }
            };
        });
    }

    async addMap(name: string, content: string, lastOpened: number): Promise<number> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.add({ name, content, lastOpened });
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(request.result as number);
            tx.onerror = () => reject(tx.error);
        });
    }

    async getMapRecord(id: number): Promise<SavedMapRecord | null> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const mapRecord = await promisifyRequest(store.get(id));
        return mapRecord ?? null;
    }

    async getAllMaps(): Promise<SavedMap[]> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const allRecords: SavedMapRecord[] = await promisifyRequest(store.getAll());
        allRecords.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
        return allRecords.map(({ id, name, lastOpened, position, scale, rotation }) => ({ id, name, lastOpened, position, scale, rotation }));
    }
    
    async updateMapView(id: number, position: Point, scale: number, rotation: number): Promise<void> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getRequest = store.get(id);

        return new Promise((resolve, reject) => {
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();

            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (record) {
                    record.position = position;
                    record.scale = scale;
                    record.rotation = rotation;
                    store.put(record);
                }
            };
        });
    }
    
    async updateMapLastOpened(id: number, lastOpened: number): Promise<void> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getRequest = store.get(id);

        return new Promise((resolve, reject) => {
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();

            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (record) {
                    record.lastOpened = lastOpened;
                    store.put(record);
                }
            };
        });
    }


    async deleteMap(id: number): Promise<void> {
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        return new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

const db = new MapDatabase();


// --- MapView Component ---
interface MapViewProps {
    mapData: SavedMapRecord;
    onBack: () => void;
}

const MapView: React.FC<MapViewProps> = ({ mapData, onBack }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isPanning, setIsPanning] = useState(false);
    const [transform, setTransform] = useState<TransformState>({
        position: mapData.position ?? { x: 0, y: 0 },
        scale: mapData.scale ?? 1,
        rotation: mapData.rotation ?? 0,
    });
    const startPanPosition = useRef<Point>({ x: 0, y: 0 });
    const lastMousePosition = useRef<Point | null>(null);
    const mouseAnimationId = useRef<number | null>(null);
    const keysPressed = useRef(new Set<string>());
    const keyAnimationId = useRef<number | null>(null);

    const { position, scale, rotation } = transform;
    const transformRef = useRef(transform);
    transformRef.current = transform;

    // Save the view state to the database, but only on unmount.
    // The `transform` dependency ensures the cleanup function captures the latest state.
    useEffect(() => {
        return () => {
            const { position, scale, rotation } = transformRef.current;
            db.updateMapView(mapData.id, position, scale, rotation);
        };
    }, [mapData.id]);

    const resetView = useCallback(() => {
        const container = containerRef.current;
        if (!container || !mapData.content) return;

        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(mapData.content, "image/svg+xml");
        const svgElement = svgDoc.querySelector('svg');
        if (!svgElement) return;

        const viewBox = svgElement.getAttribute('viewBox')?.split(' ').map(Number);
        const svgWidth = viewBox ? viewBox[2] : parseFloat(svgElement.getAttribute('width') || '1000');
        const svgHeight = viewBox ? viewBox[3] : parseFloat(svgElement.getAttribute('height') || '1000');

        const { width: containerWidth, height: containerHeight } = container.getBoundingClientRect();
        const scaleX = containerWidth / svgWidth;
        const scaleY = containerHeight / svgHeight;
        const initialScale = Math.min(scaleX, scaleY) * 0.9;
        
        setTransform({
            scale: initialScale,
            rotation: 0,
            position: {
                x: (containerWidth - svgWidth * initialScale) / 2,
                y: (containerHeight - svgHeight * initialScale) / 2
            }
        });
    }, [mapData.content]);
    
    useEffect(() => {
        if (mapData.position && typeof mapData.scale !== 'undefined') {
            setTransform({
                position: mapData.position,
                scale: mapData.scale,
                rotation: mapData.rotation ?? 0
            });
        } else {
            resetView();
        }
    }, [mapData, resetView]);

    const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        setTransform(t => {
            const scaleFactor = 1.1;
            const newScale = e.deltaY < 0 ? t.scale * scaleFactor : t.scale / scaleFactor;
            const mousePointX = (mouseX - t.position.x) / t.scale;
            const mousePointY = (mouseY - t.position.y) / t.scale;
            const newX = mouseX - mousePointX * newScale;
            const newY = mouseY - mousePointY * newScale;
            return { ...t, scale: newScale, position: { x: newX, y: newY } };
        });
    }, []);

    const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsPanning(true);
        startPanPosition.current = {
            x: e.clientX - position.x,
            y: e.clientY - position.y,
        };
        lastMousePosition.current = null;
        if (mouseAnimationId.current) {
            cancelAnimationFrame(mouseAnimationId.current);
            mouseAnimationId.current = null;
        }
    }, [position]);

    const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
        if (!isPanning) return;
        e.preventDefault();
        lastMousePosition.current = { x: e.clientX, y: e.clientY };

        if (!mouseAnimationId.current) {
            mouseAnimationId.current = requestAnimationFrame(() => {
                if (lastMousePosition.current) {
                    setTransform(t => ({
                        ...t,
                        position: {
                            x: lastMousePosition.current.x - startPanPosition.current.x,
                            y: lastMousePosition.current.y - startPanPosition.current.y,
                        }
                    }));
                }
                mouseAnimationId.current = null;
            });
        }
    }, [isPanning]);
    
    const handleMouseUpOrLeave = useCallback((e: MouseEvent<HTMLDivElement>) => {
        if (!isPanning) return;
        e.preventDefault();

        if (mouseAnimationId.current) {
            cancelAnimationFrame(mouseAnimationId.current);
            mouseAnimationId.current = null;
        }

        if (lastMousePosition.current) {
            setTransform(t => ({
                ...t,
                position: {
                    x: lastMousePosition.current.x - startPanPosition.current.x,
                    y: lastMousePosition.current.y - startPanPosition.current.y,
                }
            }));
        }
        
        setIsPanning(false);
    }, [isPanning]);

    const zoom = useCallback((direction: 'in' | 'out') => {
        const container = containerRef.current;
        if (!container) return;

        const { width, height } = container.getBoundingClientRect();
        const centerX = width / 2;
        const centerY = height / 2;
        
        setTransform(t => {
            const scaleFactor = 1.5;
            const newScale = direction === 'in' ? t.scale * scaleFactor : t.scale / scaleFactor;
            const mousePointX = (centerX - t.position.x) / t.scale;
            const mousePointY = (centerY - t.position.y) / t.scale;
            const newX = centerX - mousePointX * newScale;
            const newY = centerY - mousePointY * newScale;
            return { ...t, scale: newScale, position: { x: newX, y: newY } };
        });
    }, []);

    const animationLoop = useCallback(() => {
        if (keysPressed.current.size === 0) {
            keyAnimationId.current = null;
            return;
        }

        const container = containerRef.current;
        if (!container) {
            keyAnimationId.current = requestAnimationFrame(animationLoop);
            return;
        }

        setTransform(t => {
            let { position, scale, rotation } = t;
            let nextPosition = { ...position };
            let nextRotation = rotation;

            // Handle Panning
            const panVector = { x: 0, y: 0 };
            if (keysPressed.current.has('w')) panVector.y += PAN_SPEED;
            if (keysPressed.current.has('s')) panVector.y -= PAN_SPEED;
            if (keysPressed.current.has('a')) panVector.x += PAN_SPEED;
            if (keysPressed.current.has('d')) panVector.x -= PAN_SPEED;

            // Handle Rotation
            if (keysPressed.current.has('q') || keysPressed.current.has('e')) {
                const angleChange = keysPressed.current.has('q') ? -ROTATION_SPEED : ROTATION_SPEED;
                nextRotation = rotation + angleChange;

                const { clientWidth, clientHeight } = container;
                const centerX = clientWidth / 2;
                const centerY = clientHeight / 2;

                const dx = centerX - position.x;
                const dy = centerY - position.y;

                const angleRad = angleChange * (Math.PI / 180);
                const cosA = Math.cos(angleRad);
                const sinA = Math.sin(angleRad);
                const newDx = dx * cosA - dy * sinA;
                const newDy = dx * sinA + dy * cosA;

                nextPosition = {
                    x: centerX - newDx,
                    y: centerY - newDy
                };
            }

            nextPosition.x += panVector.x;
            nextPosition.y += panVector.y;

            return { position: nextPosition, scale, rotation: nextRotation };
        });

        keyAnimationId.current = requestAnimationFrame(animationLoop);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (['w', 'a', 's', 'd', 'q', 'e'].includes(e.key.toLowerCase())) {
                e.preventDefault();
                keysPressed.current.add(e.key.toLowerCase());
                if (!keyAnimationId.current) {
                    keyAnimationId.current = requestAnimationFrame(animationLoop);
                }
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            keysPressed.current.delete(e.key.toLowerCase());
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            if (keyAnimationId.current) {
                cancelAnimationFrame(keyAnimationId.current);
            }
        };
    }, [animationLoop]);

    return (
        <div 
            ref={containerRef}
            className="map-view-container"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUpOrLeave}
            onMouseLeave={handleMouseUpOrLeave}
        >
            <div
                className="map-content"
                style={{
                    transform: `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                    transformOrigin: '0 0',
                }}
                dangerouslySetInnerHTML={{ __html: mapData.content }}
            />
            <button className="change-map-button" onClick={onBack} aria-label="Change map file">
                Back to Menu
            </button>
            <div className="compass" aria-hidden="true">
                <div className="compass-rose">
                    <div className="compass-arrow" style={{ transform: `rotate(${rotation}deg)` }}>▲</div>
                    N
                </div>
            </div>
            <div className="map-controls">
                <button className="control-button" onClick={() => zoom('in')} aria-label="Zoom in">+</button>
                <div className="zoom-display" aria-label={`Current zoom level: ${(scale * 100).toFixed(0)}%`}>
                    {(scale * 100).toFixed(0)}%
                </div>
                <button className="control-button" onClick={() => zoom('out')} aria-label="Zoom out">-</button>
                <button className="control-button" onClick={resetView} aria-label="Reset view">⭘</button>
            </div>
        </div>
    );
};

// --- UploadScreen Component ---
interface UploadScreenProps {
    onFileUpload: (file: File) => void;
    savedMaps: SavedMap[];
    onLoadSavedMap: (id: number) => void;
    onDeleteMap: (id: number) => void;
}

const UploadScreen: React.FC<UploadScreenProps> = ({ onFileUpload, savedMaps, onLoadSavedMap, onDeleteMap }) => {
    const [showHelp, setShowHelp] = useState(false);
    
    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file && file.type === "image/svg+xml") {
           onFileUpload(file);
        } else {
            alert("Please upload a valid SVG file.");
        }
    };
    
    return (
        <div className="upload-screen">
            <div className="upload-main">
                <h1>Fictional World Map Viewer</h1>
                <p>Upload your custom SVG map to begin your adventure.</p>
                <label htmlFor="file-upload" className="file-input-label">
                    Upload New Map
                </label>
                <input 
                    id="file-upload" 
                    type="file" 
                    accept="image/svg+xml" 
                    onChange={handleFileChange} 
                />
                 <button className="help-button" onClick={() => setShowHelp(true)}>
                    How to Use
                </button>
            </div>

            {savedMaps.length > 0 && (
                 <div className="saved-maps-container">
                    <h2>Previously Loaded Maps</h2>
                    <ul className="saved-maps-list">
                       {savedMaps.map((map) => (
                           <li key={map.id} className="saved-map-item">
                               <div className="saved-map-info">
                                    <span className="saved-map-name">{map.name}</span>
                                    {map.lastOpened && (
                                        <span className="saved-map-date">
                                            Last opened: {new Date(map.lastOpened).toLocaleString()}
                                        </span>
                                    )}
                               </div>
                               <div className="saved-map-actions">
                                   <button onClick={() => onLoadSavedMap(map.id)} className="list-button load-button">Load</button>
                                   <button onClick={() => onDeleteMap(map.id)} className="list-button delete-button">Delete</button>
                               </div>
                           </li>
                       ))}
                    </ul>
                </div>
            )}
            
            {showHelp && (
                <div className="confirm-dialog-overlay" onClick={() => setShowHelp(false)}>
                    <div className="help-dialog" onClick={(e) => e.stopPropagation()}>
                        <h2>How to Use</h2>
                        <div className="help-section">
                            <h3>Map Controls</h3>
                            <ul>
                                <li><strong>Pan:</strong> Click & Drag or <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> keys</li>
                                <li><strong>Zoom:</strong> Scroll Wheel or +/- buttons</li>
                                <li><strong>Rotate:</strong> <kbd>Q</kbd> & <kbd>E</kbd> keys</li>
                                <li><strong>Reset View:</strong> Click the ⭘ button</li>
                            </ul>
                        </div>
                        <div className="confirm-dialog-actions">
                            <button onClick={() => setShowHelp(false)} className="dialog-button">Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

interface LoadingOverlayProps {
    quote: string;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ quote }) => {
    return (
        <div className="loading-overlay">
            <div className="loading-spinner">
                <div className="loading-icon">
                    <svg width="64" height="64" viewBox="0 0 100 100">
                        <g transform="rotate(45 50 50)">
                            {/* Sword */}
                            <line x1="50" y1="10" x2="50" y2="80" stroke="var(--primary-color)" strokeWidth="6" strokeLinecap="round" />
                            <line x1="35" y1="65" x2="65" y2="65" stroke="var(--primary-color)" strokeWidth="8" strokeLinecap="round" />
                            <circle cx="50" cy="85" r="5" fill="var(--primary-color)" />
                        </g>
                        <g transform="rotate(-45 50 50)">
                             {/* Pen */}
                            <path d="M 50 15 L 50 85" stroke="var(--primary-color)" strokeWidth="6" strokeLinecap="round" />
                            {/* Pen Nib */}
                            <path d="M 45 85 L 50 95 L 55 85 Z" fill="var(--primary-color)" />
                             {/* Pen Clip */}
                            <line x1="53" y1="30" x2="53" y2="55" stroke="var(--primary-color)" strokeWidth="3" strokeLinecap="round" />
                        </g>
                    </svg>
                </div>
            </div>
            <p className="loading-text">Loading Map...</p>
            <p className="loading-quote">"{quote}"</p>
        </div>
    );
};


// --- App Component ---
const App = () => {
    const [currentMapData, setCurrentMapData] = useState<SavedMapRecord | null>(null);
    const [savedMaps, setSavedMaps] = useState<SavedMap[]>([]);
    const [mapToDelete, setMapToDelete] = useState<SavedMap | null>(null);
    const [showFinalConfirm, setShowFinalConfirm] = useState<boolean>(false);
    const [deleteTimer, setDeleteTimer] = useState<number>(0);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [loadingQuote, setLoadingQuote] = useState<string>("");
    const timerIntervalRef = useRef<number | null>(null);

    useEffect(() => {
        // Cleanup function to clear interval on component unmount
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        };
    }, []);

    const refreshSavedMaps = useCallback(async () => {
        const maps = await db.getAllMaps();
        setSavedMaps(maps);
    }, []);
    
    useEffect(() => {
        refreshSavedMaps();
    }, [refreshSavedMaps]);

    const handleFileUpload = useCallback(async (file: File) => {
        const randomQuote = loadingQuotes[Math.floor(Math.random() * loadingQuotes.length)];
        setLoadingQuote(randomQuote);
        setIsLoading(true);

        try {
            const content = await file.text();
            
            const currentMapNames = new Set(savedMaps.map(m => m.name));
            let finalName = file.name;

            if (currentMapNames.has(finalName)) {
                const parts = file.name.split('.');
                const extension = parts.length > 1 ? `.${parts.pop()}` : '';
                const baseName = parts.join('.');
                let counter = 1;
                do {
                    finalName = `${baseName}_${counter}${extension}`;
                    counter++;
                } while (currentMapNames.has(finalName));
            }
            
            const mapId = await db.addMap(finalName, content, Date.now());
            const newMapData = await db.getMapRecord(mapId);
            if (newMapData) {
                setCurrentMapData(newMapData);
            }
            await refreshSavedMaps();

        } catch (error) {
            console.error("Failed to upload and process file:", error);
            alert("An error occurred while loading the map.");
        } finally {
            setIsLoading(false);
        }
    }, [savedMaps, refreshSavedMaps]);

    const handleLoadSavedMap = useCallback(async (id: number) => {
        try {
            await db.updateMapLastOpened(id, Date.now());
            const mapData = await db.getMapRecord(id);
            if (mapData) {
                setCurrentMapData(mapData);
                await refreshSavedMaps();
            } else {
                alert("Could not load map. It may have been deleted.");
                await refreshSavedMaps();
            }
        } catch (error) {
             console.error("Failed to load saved map:", error);
             alert("An error occurred while loading the saved map.");
        }
    }, [refreshSavedMaps]);

    const handleInitiateDelete = useCallback((id: number) => {
        const map = savedMaps.find(m => m.id === id);
        if(map) {
            setMapToDelete(map);
            setShowFinalConfirm(false);
            setDeleteTimer(10);
            
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

            timerIntervalRef.current = window.setInterval(() => {
                setDeleteTimer(prev => {
                    if (prev <= 1) {
                        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        }
    }, [savedMaps]);
    
    const handleProceedToFinalConfirm = () => {
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        setShowFinalConfirm(true);
    };

    const handleConfirmDelete = useCallback(async () => {
        if (!mapToDelete) return;
        try {
            await db.deleteMap(mapToDelete.id);
            setSavedMaps(prevMaps => prevMaps.filter(m => m.id !== mapToDelete.id));

            if (currentMapData && mapToDelete.id === currentMapData.id) {
                setCurrentMapData(null);
            }
        } catch (error) {
            console.error("Failed to delete map:", error);
            alert("There was an error deleting the map. Please try again.");
            await refreshSavedMaps();
        } finally {
             if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            setMapToDelete(null);
            setShowFinalConfirm(false);
        }
    }, [mapToDelete, currentMapData, refreshSavedMaps]);
    
    const handleCancelDelete = () => {
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        setMapToDelete(null);
        setShowFinalConfirm(false);
    };

    const handleBack = () => {
        setCurrentMapData(null);
    };

    return (
        <div className="app-container">
            {isLoading && <LoadingOverlay quote={loadingQuote} />}
            
            {currentMapData ? (
                <MapView 
                    key={currentMapData.id} 
                    mapData={currentMapData} 
                    onBack={handleBack} />
            ) : (
                <UploadScreen 
                    onFileUpload={handleFileUpload}
                    savedMaps={savedMaps}
                    onLoadSavedMap={handleLoadSavedMap}
                    onDeleteMap={handleInitiateDelete} 
                />
            )}

            {mapToDelete && !showFinalConfirm && (
                <div className="confirm-dialog-overlay">
                    <div className="confirm-dialog">
                        <h2>Delete Map</h2>
                        <p>Are you sure that you want to delete '{mapToDelete.name}'?</p>
                        <div className="confirm-dialog-actions">
                            <button 
                                onClick={handleProceedToFinalConfirm} 
                                className="dialog-button danger"
                                disabled={deleteTimer > 0}
                            >
                               {deleteTimer > 0 ? `Yes, delete it (${deleteTimer}s)` : 'Yes, delete it'}
                            </button>
                            <button onClick={handleCancelDelete} className="dialog-button">No, save it</button>
                        </div>
                    </div>
                </div>
            )}

            {mapToDelete && showFinalConfirm && (
                 <div className="confirm-dialog-overlay">
                    <div className="confirm-dialog">
                        <h2>Permanent Deletion</h2>
                        <p>
                            This action is <strong>permanent</strong> and cannot be undone. 
                            Are you absolutely sure you want to delete '{mapToDelete.name}' forever?
                        </p>
                        <div className="confirm-dialog-actions">
                            <button onClick={handleConfirmDelete} className="dialog-button danger">Yes, permanently delete</button>
                            <button onClick={handleCancelDelete} className="dialog-button">Cancel</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);