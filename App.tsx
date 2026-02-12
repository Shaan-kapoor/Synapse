import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Loader2, Network, VideoOff, History, X, FileJson, FileText, Trash2, Video, AlertCircle, ZoomIn, ZoomOut, Share2, Activity, Layers, Grid2X2, Focus, Hand, Play } from 'lucide-react';
import ThinkingGraph from './components/ThinkingGraph';
import { GeminiLiveService } from './services/geminiLive';
import { GraphData, SessionStatus, GraphNode, GraphLink, SessionRecord, VisMode, HandCursor } from './types';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';

const API_KEY = process.env.API_KEY || '';

const App: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // App Visibility State
  const [isAppReady, setIsAppReady] = useState(false);
  const [useCamera, setUseCamera] = useState(false);
  
  // --- Interaction State ---
  // Default to false (Gestures disabled on start)
  const [isHandTrackingEnabled, setIsHandTrackingEnabled] = useState(false);

  // Session State
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcript, setTranscript] = useState<string>('');
  
  // Camera Setup State
  const [cameraError, setCameraError] = useState<boolean>(false);
  const [permissionDenied, setPermissionDenied] = useState<boolean>(false);
  
  // Graph State
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [zoomLevel, setZoomLevel] = useState<number>(1); 
  const [visMode, setVisMode] = useState<VisMode>('network');
  const liveServiceRef = useRef<GeminiLiveService | null>(null);

  // History State
  const [history, setHistory] = useState<SessionRecord[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // --- Hand Tracking State ---
  const [cursor, setCursor] = useState<HandCursor | null>(null);
  const gestureRecognizerRef = useRef<GestureRecognizer | null>(null);
  const requestRef = useRef<number>();
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  
  // Ref to track focusedNodeId inside stable callbacks
  const focusedNodeIdRef = useRef<string | null>(null);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  
  // Gesture State Logic
  const pinchDurationRef = useRef<number>(0);
  const spreadDurationRef = useRef<number>(0); // Track "Pitch Out"/Spread gesture
  const hasTriggeredRef = useRef<boolean>(false);

  // Keep ref in sync
  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
  }, [focusedNodeId]);

  // --- MediaPipe Initialization ---
  useEffect(() => {
    let recognizer: GestureRecognizer | null = null;
    let isMounted = true;

    const loadMediaPipe = async () => {
        try {
            const vision = await FilesetResolver.forVisionTasks(
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
            );
            
            if (!isMounted) return;

            recognizer = await GestureRecognizer.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
                    delegate: "GPU" // SWITCHED TO GPU for performance
                },
                runningMode: "VIDEO",
                numHands: 1 
            });
            
            if (isMounted) {
                gestureRecognizerRef.current = recognizer;
                console.log("MediaPipe GestureRecognizer Loaded (GPU)");
            } else {
                recognizer.close();
            }
        } catch (error) {
            console.error("Failed to load MediaPipe:", error);
            // Fallback could be added here, but sticking to GPU request
        }
    };

    loadMediaPipe();

    return () => {
        isMounted = false;
        if (recognizer) {
             recognizer.close();
        }
        gestureRecognizerRef.current = null;
    };
  }, []);

  const predictWebcam = useCallback(() => {
    // 1. Basic checks
    if (!gestureRecognizerRef.current || !videoRef.current || !useCamera || !isHandTrackingEnabled) {
       if (cursor) setCursor(null);
       return; 
    }

    const video = videoRef.current;

    // 2. Check readyState
    if (video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) {
        requestRef.current = requestAnimationFrame(predictWebcam);
        return;
    }
    
    const nowInMs = Date.now();
    let results;
    try {
        results = gestureRecognizerRef.current.recognizeForVideo(video, nowInMs);
    } catch (e) {
        requestRef.current = requestAnimationFrame(predictWebcam);
        return;
    }
    
    if (results.landmarks && results.landmarks.length > 0) {
        const hand = results.landmarks[0];
        const thumbTip = hand[4];
        const indexTip = hand[8];
        
        // 1. Cursor Position (Index Tip)
        const cursorX = 1 - indexTip.x; // Mirror
        const cursorY = indexTip.y;
        
        // 2. Gesture Detection
        // Calculate distance between Index and Thumb
        const dist = Math.sqrt(
            Math.pow(thumbTip.x - indexTip.x, 2) + 
            Math.pow(thumbTip.y - indexTip.y, 2)
        );

        // Thresholds
        const isPinching = dist < 0.05; // Pinch In (Select)
        // INCREASED SENSITIVITY THRESHOLD: 
        // 0.20 requires a much wider spread than 0.12 to trigger "exit"
        const isOpen = dist > 0.20;     

        // 3. State Machine for Triggering
        if (isPinching) {
            // Increment Pinch Counter
            pinchDurationRef.current += 1;
            spreadDurationRef.current = 0; // Reset spread
            
            // Trigger SELECT after short hold (stabilization)
            if (pinchDurationRef.current > 5 && !hasTriggeredRef.current) {
                if (hoveredNodeId) {
                    if (focusedNodeId !== hoveredNodeId) {
                        enterNode(hoveredNodeId);
                        // Haptic feedback could go here
                    }
                    hasTriggeredRef.current = true;
                }
            }
        } else if (isOpen) {
            // Increment Spread Counter
            spreadDurationRef.current += 1;
            pinchDurationRef.current = 0; // Reset pinch

            // Trigger DESELECT after hold
            if (spreadDurationRef.current > 8 && !hasTriggeredRef.current) {
                if (focusedNodeId) {
                    exitNode();
                }
                hasTriggeredRef.current = true;
            }
        } else {
            // Neutral State (between pinch and open)
            pinchDurationRef.current = 0;
            spreadDurationRef.current = 0;
            hasTriggeredRef.current = false;
        }

        setCursor({
            x: cursorX,
            y: cursorY,
            isPinching: isPinching
        });

    } else {
        setCursor(null);
        pinchDurationRef.current = 0;
        spreadDurationRef.current = 0;
    }

    requestRef.current = requestAnimationFrame(predictWebcam);
  }, [useCamera, isHandTrackingEnabled, hoveredNodeId, focusedNodeId, cursor]);

  useEffect(() => {
    if (useCamera && isAppReady && isHandTrackingEnabled) {
        requestRef.current = requestAnimationFrame(predictWebcam);
    }
    return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [useCamera, isAppReady, isHandTrackingEnabled, predictWebcam]);


  // --- Graph Actions ---

  const enterNode = (nodeId: string) => {
    setFocusedNodeId(nodeId);
  };

  const exitNode = () => {
    setFocusedNodeId(null);
  };

  const enableCamera = useCallback(async () => {
    setCameraError(false);
    setPermissionDenied(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, 
        audio: false 
      });
      
      setUseCamera(true);
      setIsAppReady(true);
      
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);

    } catch (err: any) {
      console.error("Error accessing camera:", err);
      setCameraError(true);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setPermissionDenied(true);
      }
    }
  }, []);

  const skipCamera = useCallback(() => {
    setUseCamera(false);
    setIsAppReady(true);
  }, []);

  const toggleCamera = useCallback(() => {
    if (!useCamera) {
      enableCamera();
    } else {
      setUseCamera(false);
      setCursor(null);
      // Disable gestures when camera is turned off
      setIsHandTrackingEnabled(false);
      
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
    }
  }, [useCamera, enableCamera]);

  // --- App Logic (Existing) ---

  // Load History
  useEffect(() => {
    const saved = localStorage.getItem('mindmap_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    } else {
      // Default Example Session: Divergent vs Convergent Thinking
      const exampleSession: SessionRecord = {
        id: 'example-divergent-convergent',
        timestamp: Date.now(),
        transcript: "Divergent thinking is about generating many ideas, exploring possibilities, and thinking outside the box. It represents creativity and quantity. Convergent thinking, in contrast, is about narrowing down choices to find the single best correct answer. It represents logic and selection. Effective problem solving often uses both: diverging to create options, then converging to pick the solution.",
        graphData: {
          nodes: [
            { id: 'problem_solving', label: 'Problem Solving', val: 20 },
            { id: 'divergent_thinking', label: 'Divergent Thinking', val: 15 },
            { id: 'convergent_thinking', label: 'Convergent Thinking', val: 15 },
            { id: 'creativity', label: 'Creativity', val: 10 },
            { id: 'many_ideas', label: 'Many Ideas', val: 8 },
            { id: 'exploration', label: 'Exploration', val: 8 },
            { id: 'logic', label: 'Logic', val: 10 },
            { id: 'selection', label: 'Selection', val: 8 },
            { id: 'single_solution', label: 'Single Solution', val: 8 }
          ],
          links: [
            { source: 'problem_solving', target: 'divergent_thinking', value: 5 },
            { source: 'problem_solving', target: 'convergent_thinking', value: 5 },
            { source: 'divergent_thinking', target: 'creativity', value: 3 },
            { source: 'divergent_thinking', target: 'many_ideas', value: 3 },
            { source: 'divergent_thinking', target: 'exploration', value: 3 },
            { source: 'convergent_thinking', target: 'logic', value: 3 },
            { source: 'convergent_thinking', target: 'selection', value: 3 },
            { source: 'convergent_thinking', target: 'single_solution', value: 3 },
            { source: 'divergent_thinking', target: 'convergent_thinking', value: 2 }
          ]
        }
      };
      setHistory([exampleSession]);
    }
  }, []);

  // Save History
  useEffect(() => {
    localStorage.setItem('mindmap_history', JSON.stringify(history));
  }, [history]);

  // Handle Graph Updates
  const handleGraphUpdate = useCallback((update: any) => {
    setGraphData(prev => {
      const newNodesMap = new Map<string, GraphNode>(prev.nodes.map(n => [n.id, n]));
      const newLinksMap = new Map<string, GraphLink>(prev.links.map(l => {
        const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
        return [`${s}-${t}`, l];
      }));

      const currentFocus = focusedNodeIdRef.current;

      if (update.concepts) {
        update.concepts.forEach((c: any) => {
          const existing = newNodesMap.get(c.id);
          if (existing) {
            existing.val = Math.min(20, existing.val + (c.importance * 0.5)); 
          } else {
            // New Node Creation
            newNodesMap.set(c.id, { id: c.id, label: c.label, val: c.importance });
            
            // CONTEXTUAL LINKING LOGIC
            // If we are currently focused on a node, and a NEW concept comes in,
            // we assume it is related to the current focus.
            if (currentFocus && currentFocus !== c.id) {
                const linkKey = `${currentFocus}-${c.id}`;
                const reverseKey = `${c.id}-${currentFocus}`;
                
                // Only add if link doesn't exist
                if (!newLinksMap.has(linkKey) && !newLinksMap.has(reverseKey)) {
                    newLinksMap.set(linkKey, { 
                        source: currentFocus, 
                        target: c.id, 
                        value: 3 // Assign a default strength for contextual links
                    });
                }
            }
          }
        });
      }

      if (update.relationships) {
        update.relationships.forEach((r: any) => {
          const key = `${r.source_id}-${r.target_id}`;
          const existing = newLinksMap.get(key);
          
          if (newNodesMap.has(r.source_id) && newNodesMap.has(r.target_id)) {
            if (existing) {
              existing.value = Math.min(10, existing.value + (r.strength * 0.5)); 
            } else {
              newLinksMap.set(key, { source: r.source_id, target: r.target_id, value: r.strength });
            }
          }
        });
      }

      return {
        nodes: Array.from(newNodesMap.values()),
        links: Array.from(newLinksMap.values()),
      };
    });
  }, []);

  const handleTranscriptUpdate = useCallback((text: string) => {
    setTranscript(prev => {
        const combined = prev + " " + text;
        return combined.slice(-250); 
    });
  }, []);

  const saveSession = useCallback(() => {
    if (graphData.nodes.length === 0 && !transcript) return;
    
    const newRecord: SessionRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      transcript: transcript,
      graphData: graphData
    };
    
    // Clean D3 data for storage
    const cleanNodes = graphData.nodes.map(n => ({ id: n.id, label: n.label, val: n.val }));
    const cleanLinks = graphData.links.map(l => ({ 
      source: typeof l.source === 'object' ? (l.source as any).id : l.source,
      target: typeof l.target === 'object' ? (l.target as any).id : l.target,
      value: l.value 
    }));

    newRecord.graphData = { nodes: cleanNodes as any, links: cleanLinks as any };
    setHistory(prev => [newRecord, ...prev]);
  }, [graphData, transcript]);

  const toggleSession = async () => {
    if (status === SessionStatus.IDLE || status === SessionStatus.ERROR) {
      if (!API_KEY) {
        alert("API Key not found in environment variables.");
        return;
      }
      
      const service = new GeminiLiveService(API_KEY);
      liveServiceRef.current = service;
      
      try {
        await service.connect(
          handleGraphUpdate,
          handleTranscriptUpdate,
          (s) => setStatus(s as SessionStatus)
        );
      } catch (err: any) {
        console.error("Failed to connect:", err);
        alert(`Failed to start session: ${err.message || 'Unknown error'}`);
        setStatus(SessionStatus.ERROR);
      }
    } else if (status === SessionStatus.ACTIVE || status === SessionStatus.CONNECTING) {
      liveServiceRef.current?.disconnect();
      setStatus(SessionStatus.IDLE);
      saveSession(); 
    }
  };

  const clearGraph = () => {
    saveSession(); 
    setGraphData({ nodes: [], links: [] });
    setTranscript('');
    setZoomLevel(1);
    setVisMode('network');
    setFocusedNodeId(null);
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const loadSession = (item: SessionRecord) => {
    // Deep clone nodes and links to avoid mutation of history state by D3
    const nodes = item.graphData.nodes.map(n => ({ ...n }));
    const links = item.graphData.links.map(l => ({ ...l }));

    setGraphData({ nodes, links });
    setTranscript(item.transcript || '');
    setIsHistoryOpen(false);
    setZoomLevel(1);
    setFocusedNodeId(null);
  };

  const exportJSON = (item: SessionRecord) => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(item, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `mindmap_${new Date(item.timestamp).toISOString()}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const exportMarkdown = (item: SessionRecord) => {
    let md = `# MindMap Session - ${new Date(item.timestamp).toLocaleString()}\n\n`;
    md += `## Transcript Summary\n> ${item.transcript || "(No transcript captured)"}\n\n`;
    md += `## Key Concepts\n`;
    item.graphData.nodes.sort((a,b) => b.val - a.val).forEach(node => {
      md += `- **${node.label}** (Importance: ${node.val.toFixed(1)})\n`;
    });
    
    const dataStr = "data:text/markdown;charset=utf-8," + encodeURIComponent(md);
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `mindmap_${new Date(item.timestamp).toISOString()}.md`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const VisOption = ({ mode, icon: Icon, label }: { mode: VisMode, icon: any, label: string }) => (
    <button
      onClick={() => setVisMode(mode)}
      className={`p-3 rounded-xl transition-all flex items-center justify-center relative group
        ${visMode === mode ? 'bg-white text-black shadow-lg scale-105' : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white'}`}
      title={label}
    >
      <Icon className="w-5 h-5" />
      <span className="absolute right-full mr-3 px-2 py-1 bg-black/80 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
        {label}
      </span>
    </button>
  );

  // --- Render ---

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex flex-col items-center justify-center font-sans">
      
      {!isAppReady && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950 p-6 text-center">
          <div className="bg-zinc-900/80 backdrop-blur-md p-8 rounded-3xl border border-white/10 shadow-2xl flex flex-col items-center max-w-sm w-full relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500"></div>

            {cameraError ? (
                <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-6 text-red-400 ring-1 ring-red-500/30">
                    <AlertCircle className="w-8 h-8" />
                </div>
            ) : (
                <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-6 ring-1 ring-white/10">
                    <Video className="w-8 h-8 opacity-60" />
                </div>
            )}
            
            <h2 className="text-2xl font-light text-white mb-3">
              {cameraError ? 'Camera Access Issues' : 'Synapse'}
            </h2>
            
            {cameraError ? (
                <div className="text-sm text-zinc-400 mb-8 leading-relaxed space-y-2">
                    <p>We couldn't access your camera.</p>
                    {permissionDenied && (
                      <p className="text-red-300 bg-red-500/10 p-2 rounded-lg border border-red-500/20">
                         Permission was denied. Please check your browser settings or close any overlay apps (Android bubbles).
                      </p>
                    )}
                </div>
            ) : (
                <p className="text-sm text-zinc-400 mb-8 leading-relaxed">
                    Visualize your thoughts in real-time. 
                    Enable your camera for the immersive experience, or continue with audio only.
                </p>
            )}

            <div className="w-full space-y-3">
              <button 
                  onClick={enableCamera}
                  className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-white text-black hover:bg-zinc-200 transition-all font-medium shadow-lg shadow-white/5"
              >
                  <Video className="w-4 h-4" />
                  {cameraError ? 'Try Camera Again' : 'Enable Camera'}
              </button>
              
              <button 
                  onClick={skipCamera}
                  className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-all font-medium border border-white/5"
              >
                  <VideoOff className="w-4 h-4" />
                  Continue without Camera
              </button>
            </div>
          </div>
        </div>
      )}

      {isAppReady && (
        <>
          {/* Layer 0: Background */}
          {useCamera ? (
            <video 
              ref={videoRef}
              autoPlay 
              playsInline 
              muted 
              className="absolute inset-0 w-full h-full object-cover opacity-60 pointer-events-none -scale-x-100" 
            />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-zinc-900 via-black to-black opacity-80" />
          )}
          
          {/* Gesture Instruction Overlay */}
          {useCamera && isHandTrackingEnabled && !focusedNodeId && (
             <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 text-white/40 text-xs pointer-events-none bg-black/40 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 flex items-center gap-4">
                 <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400"></span> Index Finger: Move Cursor</span>
                 <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500"></span> Thumb+Index Pinch: Select Node</span>
             </div>
          )}

          {/* Layer 1: D3 Graph Overlay */}
          <div className="absolute inset-0 z-10 pointer-events-none">
            <ThinkingGraph 
                data={graphData} 
                zoomLevel={zoomLevel} 
                mode={visMode} 
                cursor={cursor}
                focusedNodeId={focusedNodeId}
                onNodeHover={setHoveredNodeId}
                onNodeDoubleClick={enterNode}
                onBackgroundClick={exitNode}
            />
          </div>

          {/* Layer 2: Branding */}
          <div className="absolute top-6 left-6 z-20 opacity-70 hover:opacity-100 transition-opacity pointer-events-none">
            <h1 className="text-white text-xl font-light tracking-widest flex items-center gap-2">
                <Network className="w-5 h-5" />
                SYNAPSE
            </h1>
          </div>
          
          {/* Layer 3: Transcript */}
          {transcript && (
              <div className="absolute bottom-32 w-full max-w-4xl px-8 text-center z-20 pointer-events-none">
                  <p className="text-white text-xl md:text-3xl font-medium drop-shadow-lg opacity-90 leading-relaxed transition-all duration-300">
                      {transcript}
                  </p>
              </div>
          )}
          
          {/* Right Sidebar Controls */}
          <div className="absolute bottom-32 right-6 z-30 flex flex-col items-center gap-6">
            
            {/* Visualization Selector */}
            <div className="flex flex-col gap-2 bg-white/5 backdrop-blur-md p-2 rounded-2xl border border-white/10">
              <VisOption mode="network" icon={Share2} label="Network Graph" />
              <VisOption mode="stream" icon={Activity} label="Stream Timeline" />
              <VisOption mode="layers" icon={Layers} label="Hierarchical Layers" />
              <VisOption mode="cluster" icon={Grid2X2} label="Concept Cluster" />
            </div>

            {/* Zoom Controls */}
            <div className="flex flex-col items-center gap-2 bg-white/5 backdrop-blur-md p-2 rounded-full border border-white/10">
              <button 
                onClick={() => setZoomLevel(z => Math.min(3, z + 0.1))} 
                className="p-2 text-white/70 hover:text-white transition-colors"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <div className="h-24 w-1 bg-white/10 rounded-full relative group">
                <div className="absolute bottom-0 w-full bg-white/40 rounded-full transition-all duration-300" style={{ height: `${(zoomLevel / 3) * 100}%` }}></div>
                <input 
                  type="range" 
                  min="0.2" 
                  max="3" 
                  step="0.1"
                  value={zoomLevel}
                  onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  style={{ appearance: 'slider-vertical' } as any}
                />
              </div>
              <button 
                onClick={() => setZoomLevel(z => Math.max(0.2, z - 0.1))} 
                className="p-2 text-white/70 hover:text-white transition-colors"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Layer 4: Bottom Controls */}
          <div className="absolute bottom-10 z-30 flex items-center gap-4">
            
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="p-4 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white/80 hover:bg-white/20 transition-all"
              title="History"
            >
              <History className="w-5 h-5" />
            </button>
            
            <div className="flex bg-white/10 backdrop-blur-md rounded-full border border-white/20 p-1">
                <button 
                  onClick={toggleCamera}
                  className={`p-3 rounded-full transition-all ${useCamera ? 'bg-white/20 text-white shadow-sm' : 'text-white/50 hover:text-white'}`}
                  title={useCamera ? "Turn Camera Off" : "Turn Camera On"}
                >
                  {useCamera ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                </button>
                {useCamera && (
                    <button 
                        onClick={() => setIsHandTrackingEnabled(!isHandTrackingEnabled)}
                        className={`p-3 rounded-full transition-all ${isHandTrackingEnabled ? 'bg-blue-500/20 text-blue-300 shadow-sm' : 'text-white/50 hover:text-white'}`}
                        title="Toggle Hand Tracking"
                    >
                        <Hand className="w-5 h-5" />
                    </button>
                )}
            </div>

            {graphData.nodes.length > 0 && status === SessionStatus.IDLE && (
                <button 
                    onClick={clearGraph}
                    className="px-6 py-4 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white/80 hover:bg-white/20 transition-all text-sm font-medium"
                >
                    New Session
                </button>
            )}

            <button 
                onClick={toggleSession}
                disabled={status === SessionStatus.CONNECTING}
                className={`
                    group relative flex items-center justify-center gap-3 px-8 py-4 rounded-full backdrop-blur-xl border transition-all duration-300 shadow-2xl
                    ${status === SessionStatus.ACTIVE 
                    ? 'bg-red-500/20 border-red-500/50 text-red-100 hover:bg-red-500/30' 
                    : 'bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/40'
                    }
                `}
            >
                {status === SessionStatus.CONNECTING ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                ) : status === SessionStatus.ACTIVE ? (
                    <>
                        <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                        </span>
                        <span className="font-medium tracking-wide">End Session</span>
                    </>
                ) : (
                    <>
                        <Mic className="w-5 h-5 group-hover:scale-110 transition-transform" />
                        <span className="font-medium tracking-wide">Start Thinking</span>
                    </>
                )}
            </button>
          </div>

          {/* Layer 5: History Modal */}
          {isHistoryOpen && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
              <div className="w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between p-6 border-b border-white/10">
                  <h2 className="text-xl font-light text-white flex items-center gap-2">
                    <History className="w-5 h-5 text-zinc-400" />
                    Session History
                  </h2>
                  <button 
                    onClick={() => setIsHistoryOpen(false)}
                    className="p-2 hover:bg-white/10 rounded-full transition-colors text-zinc-400 hover:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
                  {history.length === 0 ? (
                    <div className="text-center text-zinc-500 py-12 flex flex-col items-center gap-3">
                      <History className="w-12 h-12 opacity-20" />
                      <p>No history found.</p>
                    </div>
                  ) : (
                    history.map((item) => (
                      <div 
                        key={item.id} 
                        onClick={() => loadSession(item)}
                        className="group bg-zinc-800/50 hover:bg-zinc-800 border border-white/5 hover:border-white/20 rounded-xl p-4 transition-all cursor-pointer relative"
                        title="Click to load this session"
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <p className="text-sm text-zinc-400 font-mono">
                              {new Date(item.timestamp).toLocaleString()}
                            </p>
                            <p className="text-white font-medium mt-1">
                              {item.graphData.nodes.length} Concepts
                            </p>
                          </div>
                          
                          <div className="flex items-center gap-2">
                             <div className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-blue-400 font-medium mr-2 flex items-center gap-1">
                                <Play className="w-3 h-3" /> Load
                             </div>
                             <button 
                                onClick={(e) => { e.stopPropagation(); deleteHistoryItem(item.id); }}
                                className="p-2 text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 rounded-full hover:bg-white/5"
                                title="Delete"
                             >
                                <Trash2 className="w-4 h-4" />
                             </button>
                          </div>
                        </div>
                        
                        {item.transcript && (
                          <p className="text-zinc-400 text-sm line-clamp-2 mb-4 italic pl-2 border-l-2 border-zinc-700">
                            "{item.transcript}"
                          </p>
                        )}

                        <div className="flex gap-3 pt-2">
                          <button 
                            onClick={(e) => { e.stopPropagation(); exportJSON(item); }}
                            className="flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-black/40 hover:bg-black/60 text-xs text-zinc-300 font-medium transition-colors border border-white/5 hover:border-white/20"
                          >
                            <FileJson className="w-4 h-4" />
                            JSON
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); exportMarkdown(item); }}
                            className="flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-black/40 hover:bg-black/60 text-xs text-zinc-300 font-medium transition-colors border border-white/5 hover:border-white/20"
                          >
                            <FileText className="w-4 h-4" />
                            Markdown
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
};

export default App;