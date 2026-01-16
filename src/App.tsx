import { useState, useEffect, useRef, useCallback } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard, type PieceDropHandlerArgs } from 'react-chessboard';
import Webcam from 'react-webcam';
import { FilesetResolver, HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';

function App() {
  const [game, setGame] = useState<Chess>(new Chess());
  const [difficulty, setDifficulty] = useState<'amateur' | 'media' | 'alta'>('amateur');
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [statusMessage, setStatusMessage] = useState('¡Nueva partida! Juegas con blancas');
  const [gestureStatus, setGestureStatus] = useState('Esperando detección de manos...');
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const [highlightedSquare, setHighlightedSquare] = useState<Square | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const cameraWidth = 360;
  const cameraHeight = 270;
  const boardSize = 620;

  // Estados para el arrastre con pellizco
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartSquare, setDragStartSquare] = useState<Square | null>(null);
  const lastPinchTime = useRef<number>(0);
  const isPinchingRef = useRef<boolean>(false);
  const lastDetectionTime = useRef<number>(0);
  const pinchDebounceRef = useRef<number>(0);

  // ────────────────────────────────────────────────
  // Lógica ajedrez
  // ────────────────────────────────────────────────
  const makeMove = useCallback((source: Square, target: Square): boolean => {
    try {
      const gameCopy = new Chess(game.fen());
      const move = gameCopy.move({ from: source, to: target, promotion: 'q' });
      if (move === null) {
        setStatusMessage('Movimiento inválido');
        return false;
      }
      setGame(gameCopy);
      setStatusMessage('¡Movimiento hecho!');
      return true;
    } catch (error) {
      setStatusMessage('Error en movimiento');
      return false;
    }
  }, [game]);

  const makeAIMove = useCallback(() => {
    if (game.isGameOver() || game.isDraw() || game.turn() !== 'b') return;
    const possibleMoves = game.moves({ verbose: true });
    if (possibleMoves.length === 0) return;
    const randomIndex = Math.floor(Math.random() * possibleMoves.length);
    const gameCopy = new Chess(game.fen());
    gameCopy.move(possibleMoves[randomIndex]);
    setGame(gameCopy);
    setStatusMessage(`IA movió... tu turno`);
  }, [game]);

  useEffect(() => {
    if (game.turn() === 'b' && !game.isGameOver() && !game.isDraw()) {
      const timer = setTimeout(makeAIMove, 800);
      return () => clearTimeout(timer);
    }
  }, [game, difficulty, makeAIMove]);

  const onDrop = useCallback(({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
    if (game.turn() !== 'w') return false;
    const success = makeMove(sourceSquare as Square, targetSquare as Square);
    if (success) setStatusMessage('¡Buen movimiento!');
    return success;
  }, [game, makeMove]);

  const resetGame = useCallback(() => {
    setGame(new Chess());
    setStatusMessage('¡Nueva partida!');
    setSelectedSquare(null);
    setHighlightedSquare(null);
    setIsDragging(false);
    setDragStartSquare(null);
    isPinchingRef.current = false;
  }, []);

  // ────────────────────────────────────────────────
  // MediaPipe - Inicialización
  // ────────────────────────────────────────────────
  useEffect(() => {
    const initialize = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
        );
        handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          numHands: 2,
          runningMode: 'VIDEO',
        });
        setGestureStatus('¡Modelo cargado! Pellizca una pieza para arrastrarla');
      } catch (err) {
        console.error('Error cargando modelo:', err);
        setGestureStatus('Error al cargar el modelo');
      }
    };
    initialize();
    return () => {
      handLandmarkerRef.current?.close();
    };
  }, []);

  // ────────────────────────────────────────────────
  // Loop de detección continua - Pellizco y Arrastre
  // ────────────────────────────────────────────────
  useEffect(() => {
    let animationFrameId: number;

    const detect = () => {
      if (
        !webcamRef.current?.video ||
        webcamRef.current.video.readyState !== 4 ||
        !handLandmarkerRef.current ||
        !canvasRef.current
      ) {
        animationFrameId = requestAnimationFrame(detect);
        return;
      }

      try {
        const video = webcamRef.current.video;
        const now = performance.now();
        const detections = handLandmarkerRef.current.detectForVideo(video, now);
        const ctx = canvasRef.current.getContext('2d');
        
        if (ctx) {
          ctx.save();
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.drawImage(video, 0, 0, canvasRef.current.width, canvasRef.current.height);
          
          drawGridOnCamera(ctx, canvasRef.current.width, canvasRef.current.height);
          
          const drawingUtils = new DrawingUtils(ctx);
          let hasHand = false;
          
          if (detections.landmarks.length > 0) {
            hasHand = true;
            lastDetectionTime.current = now;
            
            detections.landmarks.forEach((landmarks) => {
              drawingUtils.drawLandmarks(landmarks, { color: '#FFEB3B', lineWidth: 2, radius: 6 });
              drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: '#FFEB3B', lineWidth: 5 });
            });

            const landmarks = detections.landmarks[0];
            const indexFinger = landmarks[8];
            const thumb = landmarks[4];
            
            // Calcular distancia de pellizco
            const pinchDist = Math.sqrt(
              Math.pow(thumb.x - indexFinger.x, 2) +
              Math.pow(thumb.y - indexFinger.y, 2)
            );
            
            const isPinching = pinchDist < 0.08; // Umbral para pellizco
            
            // Debounce para evitar fluctuaciones
            if (now - pinchDebounceRef.current > 100) {
              isPinchingRef.current = isPinching;
              pinchDebounceRef.current = now;
            }
            
            // Actualizar cursor en el tablero
            const boardRect = boardContainerRef.current?.getBoundingClientRect();
            if (boardRect) {
              const boardX = (1 - indexFinger.x) * boardRect.width;
              const boardY = indexFinger.y * boardRect.height;
              
              cursorPosRef.current = { x: boardX, y: boardY };
              setCursorPos({ x: boardX, y: boardY });

              // Resaltar casilla bajo el cursor
              const currentSquare = getSquareFromPosition(boardX, boardY, boardRect.width, boardRect.height);
              setHighlightedSquare(currentSquare);

              // LÓGICA DE PELLIZCO Y ARRASTRE
              if (isPinchingRef.current && !isDragging) {
                // INICIO DE PELLIZCO - Intentar agarrar pieza
                if (now - lastPinchTime.current > 300) { // Debounce de 300ms
                  lastPinchTime.current = now;
                  
                  if (currentSquare) {
                    const piece = game.get(currentSquare);
                    // Solo permitir mover piezas blancas en el turno del jugador
                    if (piece && piece.color === 'w' && game.turn() === 'w') {
                      setIsDragging(true);
                      setDragStartSquare(currentSquare);
                      setSelectedSquare(currentSquare);
                      setGestureStatus(`Arrastrando desde ${currentSquare}`);
                    } else if (piece && piece.color === 'b') {
                      setGestureStatus('Espera tu turno - solo mueves blancas');
                    } else if (!piece) {
                      setGestureStatus('No hay pieza en esta casilla');
                    }
                  }
                }
              } 
              else if (isPinchingRef.current && isDragging && dragStartSquare) {
                // ARRASTRANDO - Mover la pieza
                if (currentSquare && currentSquare !== dragStartSquare) {
                  setGestureStatus(`Arrastrando: ${dragStartSquare} → ${currentSquare}`);
                } else {
                  setGestureStatus(`Arrastrando desde ${dragStartSquare}`);
                }
              }
              else if (!isPinchingRef.current && isDragging && dragStartSquare) {
                // SOLTAR PELLIZCO - Intentar mover pieza
                setIsDragging(false);
                
                if (currentSquare && dragStartSquare !== currentSquare) {
                  const success = makeMove(dragStartSquare, currentSquare);
                  if (success) {
                    setGestureStatus(`¡Movido! ${dragStartSquare} → ${currentSquare}`);
                  } else {
                    setGestureStatus(`Movimiento inválido: ${dragStartSquare} → ${currentSquare}`);
                  }
                } else if (currentSquare === dragStartSquare) {
                  setGestureStatus('Pieza soltada en la misma casilla');
                }
                
                // Limpiar selección
                setSelectedSquare(null);
                setDragStartSquare(null);
              }
              else if (!isDragging) {
                // MODO NORMAL - Solo apuntando
                if (currentSquare) {
                  const piece = game.get(currentSquare);
                  if (piece) {
                    if (piece.color === 'w' && game.turn() === 'w') {
                      setGestureStatus(`Pieza ${piece.type} en ${currentSquare} - Pellizca para mover`);
                    } else {
                      setGestureStatus(`Casilla ${currentSquare}`);
                    }
                  } else {
                    setGestureStatus(`Casilla ${currentSquare}`);
                  }
                } else {
                  setGestureStatus('Apunta al tablero');
                }
              }
            }
          }
          
          if (!hasHand && now - lastDetectionTime.current > 1500) {
            setCursorPos(null);
            cursorPosRef.current = null;
            setHighlightedSquare(null);
            setGestureStatus('No se detecta mano');
            
            // Si perdemos la mano mientras arrastramos, cancelar
            if (isDragging) {
              setIsDragging(false);
              setSelectedSquare(null);
              setDragStartSquare(null);
              setGestureStatus('Arrastre cancelado - mano perdida');
            }
          }
          
          ctx.restore();
        }
      } catch (err) {
        console.error('Error en detección:', err);
      }
      
      animationFrameId = requestAnimationFrame(detect);
    };
    
    detect();
    
    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [game, makeMove, isDragging, dragStartSquare]);

  // Dibujar cuadrícula 8x8 en cámara
  function drawGridOnCamera(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    const cw = w / 8;
    const ch = h / 8;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * ch); ctx.lineTo(w, i * ch); ctx.stroke();
    }
  }

  function getSquareFromPosition(x: number, y: number, boardW: number, boardH: number): Square | null {
    const fileIdx = Math.floor(x / (boardW / 8));
    const rankIdx = 7 - Math.floor(y / (boardH / 8));
    if (fileIdx < 0 || fileIdx > 7 || rankIdx < 0 || rankIdx > 7) return null;
    return `${'abcdefgh'[fileIdx]}${rankIdx + 1}` as Square;
  }

  // ────────────────────────────────────────────────
  // Render final
  // ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-indigo-950 to-purple-950 text-white flex flex-col items-center p-4 md:p-6">
      <h1 className="text-4xl md:text-6xl font-extrabold mb-8 text-yellow-400 drop-shadow-2xl animate-pulse">
        Ajedrez Mágico con Cámara
      </h1>
      
      {/* Controles */}
      <div className="w-full max-w-lg bg-gradient-to-r from-purple-900/70 to-indigo-900/70 backdrop-blur-lg p-6 rounded-2xl shadow-2xl border border-purple-500/50 mb-8">
        <div className="mb-6">
          <label className="block text-xl font-semibold mb-3 text-yellow-300">
            Dificultad IA
          </label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as any)}
            className="w-full p-4 bg-indigo-800/80 border border-yellow-500/70 rounded-xl text-white text-lg focus:ring-4 focus:ring-yellow-400/50 transition-all shadow-inner"
          >
            <option value="amateur">Amateur</option>
            <option value="media">Media</option>
            <option value="alta">Alta</option>
          </select>
        </div>
        <div className="flex gap-4">
          <button onClick={resetGame} className="flex-1 py-4 bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-600 hover:to-amber-700 text-black font-bold text-lg rounded-xl shadow-xl hover:scale-105 transition-all duration-300">
            Nueva Partida
          </button>
          <button onClick={() => setBoardOrientation(prev => prev === 'white' ? 'black' : 'white')} className="flex-1 py-4 bg-indigo-700 hover:bg-indigo-600 rounded-xl font-semibold text-lg transition-all duration-300 shadow-xl">
            Girar Tablero
          </button>
        </div>
      </div>
      
      {/* CÁMARA Y TABLERO */}
      <div className="w-full max-w-6xl flex flex-col lg:flex-row gap-6 mb-10 items-start">
        {/* CÁMARA */}
        <div className="lg:w-2/5 w-full">
          <div className="bg-gradient-to-br from-indigo-900/80 to-purple-900/80 p-5 rounded-3xl shadow-2xl border border-purple-500/40">
            <h2 className="text-2xl font-bold mb-4 text-center text-yellow-300 drop-shadow-md">
              Cámara – Gestos
            </h2>
            <div className="relative rounded-2xl overflow-hidden border-4 border-indigo-600/60 shadow-inner mb-3">
              <Webcam
                ref={webcamRef}
                audio={false}
                videoConstraints={{ facingMode: 'user', width: cameraWidth, height: cameraHeight }}
                className="w-full h-auto rounded-2xl"
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full rounded-2xl"
                width={cameraWidth}
                height={cameraHeight}
              />
            </div>
            <div className="bg-gray-900/70 p-4 rounded-xl border border-yellow-500/30">
              <p className="text-center text-lg font-medium text-green-300 min-h-[2.5rem] flex items-center justify-center mb-2">
                {gestureStatus}
              </p>
              <div className="text-sm text-gray-300 grid grid-cols-1 gap-2">
                <div className="bg-gray-800/50 p-3 rounded-lg">
                  <p className="text-yellow-300 font-semibold mb-1">Instrucciones de Movimiento:</p>
                  <div className="space-y-1">
                    <p>1. <span className="text-cyan-300">Apunta</span> con el dedo a una pieza blanca</p>
                    <p>2. <span className="text-green-300">Pellizca</span> (une índice y pulgar) para agarrarla</p>
                    <p>3. <span className="text-yellow-300">Arrastra</span> manteniendo el pellizco</p>
                    <p>4. <span className="text-red-300">Suelta</span> el pellizco para soltar la pieza</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* TABLERO */}
        <div className="lg:w-3/5 w-full">
          <div
            ref={boardContainerRef}
            className="bg-gradient-to-br from-purple-950/90 to-indigo-950/90 p-5 rounded-3xl shadow-2xl border-4 border-yellow-600/50 flex justify-center items-center"
          >
            <div style={{ width: '100%', maxWidth: `${boardSize}px`, position: 'relative' }}>
              <Chessboard
                boardWidth={boardSize}
                options={{
                  position: game.fen(),
                  onPieceDrop: onDrop,
                  boardOrientation,
                  arePiecesDraggable: game.turn() === 'w' && !game.isGameOver(),
                  customDarkSquareStyle: { backgroundColor: '#4a148c' },
                  customLightSquareStyle: { backgroundColor: '#7b1fa2' },
                  animationDuration: 350,
                  customSquareStyles: {
                    ...(highlightedSquare ? {
                      [highlightedSquare]: {
                        backgroundColor: 'rgba(255, 215, 0, 0.4)',
                        boxShadow: 'inset 0 0 15px rgba(255, 215, 0, 0.5)',
                        borderRadius: '4px'
                      }
                    } : {}),
                    ...(selectedSquare ? {
                      [selectedSquare]: {
                        backgroundColor: 'rgba(34, 197, 94, 0.7)',
                        boxShadow: 'inset 0 0 20px rgba(34, 197, 94, 0.9)',
                        borderRadius: '4px'
                      }
                    } : {})
                  },
                }}
              />
              
              {/* Cursor de mano con feedback de arrastre */}
              <div className="absolute pointer-events-none inset-0 z-50">
                {cursorPos && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      transform: `translate(${cursorPos.x}px, ${cursorPos.y}px) translate(-50%, -50%)`,
                      transition: 'transform 0.04s ease-out',
                      willChange: 'transform',
                    }}
                  >
                    {/* Cursor estilo mano - cambia según estado */}
                    <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                      {/* Sombra */}
                      <path
                        d="M14 4 L14 30 L22 22 L26 34 L32 30 L26 18 L36 18 L14 4 Z"
                        fill="rgba(0,0,0,0.4)"
                        transform="translate(2, 2)"
                      />
                      
                      {/* Mano */}
                      <path
                        d="M14 4 L14 30 L22 22 L26 34 L32 30 L26 18 L36 18 L14 4 Z"
                        fill={isDragging ? '#22c55e' : '#ffffff'}
                        stroke={isDragging ? '#16a34a' : '#3b82f6'}
                        strokeWidth="2"
                      />
                      
                      {/* Indicador de pellizco cuando está arrastrando */}
                      {isDragging && (
                        <>
                          <circle cx="22" cy="10" r="5" fill="#22c55e" opacity="0.9">
                            <animate attributeName="r" values="5;7;5" dur="0.8s" repeatCount="indefinite" />
                          </circle>
                          <circle cx="22" cy="10" r="3" fill="#ffffff" />
                        </>
                      )}
                      
                      {/* Indicador de apuntando cuando no está arrastrando */}
                      {!isDragging && (
                        <circle cx="36" cy="4" r="3" fill="#3b82f6" opacity="0.8">
                          <animate attributeName="opacity" values="0.8;0.4;0.8" dur="1.5s" repeatCount="indefinite" />
                        </circle>
                      )}
                    </svg>
                    
                    {/* Flecha de movimiento cuando está arrastrando */}
                    {isDragging && dragStartSquare && highlightedSquare && dragStartSquare !== highlightedSquare && (
                      <div className="absolute -top-14 left-1/2 transform -translate-x-1/2">
                        <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold whitespace-nowrap shadow-2xl border border-green-400 animate-pulse">
                          {dragStartSquare} → {highlightedSquare}
                          <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-emerald-600"></div>
                        </div>
                      </div>
                    )}
                    
                    {/* Indicador de pieza agarrada */}
                    {isDragging && dragStartSquare && (
                      <div className="absolute -bottom-10 left-1/2 transform -translate-x-1/2">
                        <div className="bg-gradient-to-r from-emerald-600 to-green-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap shadow-xl border border-emerald-500">
                          Pieza agarrada ✓
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Estado del juego */}
      <div className={`w-full max-w-6xl text-3xl font-extrabold mb-6 p-4 rounded-2xl shadow-xl border-2 ${game.isCheckmate() ? 'bg-red-900/70 text-red-300 border-red-500 animate-pulse' :
          game.isDraw() ? 'bg-green-900/70 text-green-300 border-green-500' :
            game.inCheck() ? 'bg-orange-900/70 text-orange-300 border-orange-500' :
              'bg-indigo-900/70 text-yellow-300 border-yellow-500'
        }`}>
        {game.isCheckmate() ? '¡Jaque Mate!' :
          game.isDraw() ? 'Tablas' :
            game.inCheck() ? '¡Jaque!' : statusMessage}
      </div>
      
      <div className="text-gray-300 text-base bg-gray-900/60 px-5 py-3 rounded-xl border border-purple-600/40">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <span>Movimientos: <span className="text-yellow-300 font-bold">{game.history().length}</span></span>
          <span>•</span>
          <span>Turno: <span className={`font-bold ${game.turn() === 'w' ? 'text-green-300' : 'text-red-300'}`}>
            {game.turn() === 'w' ? 'Tú (blancas)' : 'IA (negras)'}
          </span></span>
          <span>•</span>
          <span>Estado: <span className={`font-bold ${isDragging ? 'text-green-400' : 'text-blue-300'}`}>
            {isDragging ? 'Arrastrando pieza' : 'Listo para mover'}
          </span></span>
          {dragStartSquare && (
            <>
              <span>•</span>
              <span>Origen: <span className="text-yellow-300 font-bold">{dragStartSquare}</span></span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;