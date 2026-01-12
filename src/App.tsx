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
  const [smoothedCursor, setSmoothedCursor] = useState<{ x: number; y: number } | null>(null);
  const [highlightedSquare, setHighlightedSquare] = useState<Square | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [isPinching, setIsPinching] = useState(false);

  const lastPinchTime = useRef(0);
  const lastDetectionTime = useRef(0);
  const prevPinchState = useRef(false);

  const cameraWidth = 360;
  const cameraHeight = 270;
  const boardSize = 620; // más grande como pediste

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
    setIsPinching(false);
  }, []);

  // ────────────────────────────────────────────────
  // MediaPipe + Cursor rojo en tablero real + Cuadrícula
  // ────────────────────────────────────────────────

  useEffect(() => {
    let animationFrameId: number;

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

        setGestureStatus('¡Modelo cargado! Apunta con el dedo índice');
      } catch (err) {
        console.error('Error cargando modelo:', err);
        setGestureStatus('Error al cargar el modelo');
      }
    };

    initialize();

    const detect = async () => {
      if (
        webcamRef.current?.video?.readyState === 4 &&
        handLandmarkerRef.current &&
        canvasRef.current
      ) {
        const video = webcamRef.current.video;
        const detections = handLandmarkerRef.current.detectForVideo(video, performance.now());

        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.drawImage(video, 0, 0, canvasRef.current.width, canvasRef.current.height);

          // Cuadrícula siempre visible en cámara
          drawGridOnCamera(ctx, canvasRef.current.width, canvasRef.current.height);

          const drawingUtils = new DrawingUtils(ctx);

          let hasHand = false;

          if (detections.landmarks.length > 0) {
            hasHand = true;
            lastDetectionTime.current = performance.now();

            detections.landmarks.forEach((landmarks) => {
              drawingUtils.drawLandmarks(landmarks, { color: '#FFEB3B', lineWidth: 2, radius: 6 });
              drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: '#FFEB3B', lineWidth: 5 });
            });

            const landmarks = detections.landmarks[0];
            const indexFinger = landmarks[8];
            const thumb = landmarks[4];

            const pinchDist = Math.hypot(
              thumb.x - indexFinger.x,
              thumb.y - indexFinger.y,
              thumb.z - indexFinger.z
            );

            const pinching = pinchDist < 0.06;

            // Debounce para evitar múltiples triggers
            const now = performance.now();
            if (pinching !== prevPinchState.current && now - lastPinchTime.current > 400) {
              lastPinchTime.current = now;
              prevPinchState.current = pinching;

              if (pinching && !isPinching) {
                const sq = getSquareFromNormalized(indexFinger.x, indexFinger.y);
                if (sq) {
                  setSelectedSquare(sq);
                  setGestureStatus(`Seleccionado: ${sq} – mueve para soltar`);
                }
                setIsPinching(true);
              } else if (!pinching && isPinching && selectedSquare) {
                const target = getSquareFromNormalized(indexFinger.x, indexFinger.y);
                if (target && target !== selectedSquare) {
                  makeMove(selectedSquare, target);
                }
                setSelectedSquare(null);
                setIsPinching(false);
              }
            }

            // Puntero rojo en el tablero real
            const boardRect = boardContainerRef.current?.getBoundingClientRect();
            if (boardRect) {
              const rawX = (1 - indexFinger.x) * boardRect.width + boardRect.left;
              const rawY = indexFinger.y * boardRect.height + boardRect.top;

              setCursorPos({ x: rawX, y: rawY });

              // Suavizado
              setSmoothedCursor(prev => {
                if (!prev) return { x: rawX, y: rawY };
                return {
                  x: prev.x * 0.8 + rawX * 0.2,
                  y: prev.y * 0.8 + rawY * 0.2,
                };
              });

              // Resaltar casilla bajo puntero
              const sq = getSquareFromPosition(rawX - boardRect.left, rawY - boardRect.top, boardRect.width, boardRect.height);
              setHighlightedSquare(sq);
            }

            setGestureStatus(`Dedo activo • ${pinching ? 'Pellizcando' : 'Libre'}`);
          }

          if (!hasHand && performance.now() - lastDetectionTime.current > 1500) {
            setCursorPos(null);
            setSmoothedCursor(null);
            setHighlightedSquare(null);
            setGestureStatus('No se detecta mano');
          }

          ctx.restore();
        }
      }

      animationFrameId = requestAnimationFrame(detect);
    };

    if (webcamRef.current?.video) {
      webcamRef.current.video.onloadedmetadata = () => detect();
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      handLandmarkerRef.current?.close();
    };
  }, [isPinching, selectedSquare, makeMove]);

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

  function getSquareFromNormalized(normX: number, normY: number): Square | null {
    const fileIdx = Math.floor((1 - normX) * 8);
    const rankIdx = 7 - Math.floor(normY * 8);
    if (fileIdx < 0 || fileIdx > 7 || rankIdx < 0 || rankIdx > 7) return null;
    return `${'abcdefgh'[fileIdx]}${rankIdx + 1}` as Square;
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

      {/* Layout: Cámara izquierda + Tablero derecha */}
      <div className="w-full max-w-6xl flex flex-col lg:flex-row gap-8 mb-10">
        {/* Cámara izquierda */}
        <div className="flex-1 bg-gradient-to-br from-indigo-900/80 to-purple-900/80 p-6 rounded-3xl shadow-2xl border border-purple-500/40 max-w-md">
          <h2 className="text-2xl font-bold mb-5 text-center text-yellow-300 drop-shadow-md">
            Cámara – Gestos
          </h2>
          <div className="relative rounded-2xl overflow-hidden border-4 border-indigo-600/60 shadow-inner">
            <Webcam
              ref={webcamRef}
              audio={false}
              videoConstraints={{ facingMode: 'user', width: cameraWidth, height: cameraHeight }}
              className="w-full rounded-2xl"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full rounded-2xl"
              width={cameraWidth}
              height={cameraHeight}
            />
          </div>
          <p className="mt-5 text-center text-lg font-medium text-green-300">
            {gestureStatus}
          </p>
        </div>

        {/* Tablero derecha */}
        <div
          ref={boardContainerRef}
          style={{ width: `${boardSize}px`, maxWidth: '100%', position: 'relative' }}
          className="flex-1 bg-gradient-to-br from-purple-950/90 to-indigo-950/90 p-6 rounded-3xl shadow-2xl border-4 border-yellow-600/50"
        >
          <Chessboard
            options={{
              position: game.fen(),
              onPieceDrop: onDrop,
              boardOrientation,
              arePiecesDraggable: game.turn() === 'w' && !game.isGameOver(),
              customDarkSquareStyle: { backgroundColor: '#4a148c' },
              customLightSquareStyle: { backgroundColor: '#7b1fa2' },
              animationDuration: 350,
              customSquareStyles: highlightedSquare ? {
                [highlightedSquare]: { backgroundColor: 'rgba(255, 215, 0, 0.45)' }
              } : {},
            }}
          />

          {/* Puntero rojo en el tablero real */}
          {smoothedCursor && (
            <div
              className="absolute w-10 h-10 rounded-full bg-red-600 border-4 border-white shadow-2xl pointer-events-none transform -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center"
              style={{
                left: smoothedCursor.x,
                top: smoothedCursor.y,
                transition: 'all 0.12s ease-out',
                opacity: cursorPos ? 0.95 : 0.3,
              }}
            >
              {selectedSquare ? '●' : ''}
            </div>
          )}
        </div>
      </div>

      {/* Estado */}
      <div className={`text-3xl font-extrabold mb-6 p-4 rounded-2xl shadow-xl border-2 ${game.isCheckmate() ? 'bg-red-900/70 text-red-300 border-red-500 animate-pulse' :
          game.isDraw() ? 'bg-green-900/70 text-green-300 border-green-500' :
            game.inCheck() ? 'bg-orange-900/70 text-orange-300 border-orange-500' :
              'bg-indigo-900/70 text-yellow-300 border-yellow-500'
        }`}>
        {game.isCheckmate() ? '¡Jaque Mate!' :
          game.isDraw() ? 'Tablas' :
            game.inCheck() ? '¡Jaque!' : statusMessage}
      </div>

      <div className="text-gray-300 text-base bg-gray-900/60 px-5 py-3 rounded-xl border border-purple-600/40">
        Movimientos: {game.history().length} • Turno: {game.turn() === 'w' ? 'Tú (blancas)' : 'IA (negras)'}
      </div>
    </div>
  );
}

export default App;