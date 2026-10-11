import React, { useState, useEffect, useRef } from "react";
import Loader from "./components/loader";
import ButtonHandler from "./components/btn-handler";
import { detect, detectVideo } from "./utils/detect";
import { createDetector, requestedBackendOrder } from "./utils/detector";
import "./style/App.css";
import DownloadButton from "./components/DownloadButton";


const App = () => {

    const [loading, setLoading] = useState({ loading: true, progress: 0 }); // loading state
    const [model, setModel] = useState({
        net: null,
        inputShape: [1, 0, 0, 3],
    }); // init model & input shape

    const [loadError, setLoadError] = useState(null);
    const [backendInfo, setBackendInfo] = useState(null); // shown only with ?debug in the URL
    const [annotatedSrc, setAnnotatedSrc] = useState(null);
    const [recordedBlob, setRecordedBlob] = useState(null);
    const [recordingState, setRecordingState] = useState("idle"); // idle | recording | saving | unavailable
    const [lastInput, setLastInput] = useState(null); // image | video | null: decides which image button to show

    // references
    const imageRef = useRef(null);
    const cameraRef = useRef(null);
    const videoRef = useRef(null);
    const canvasRef = useRef(null);

    // model configs
    const modelName = "yolo11nquantized";

    useEffect(() => {
        let cancelled = false;
        let detector = null;

        // absolute URL: independent of the page URL and usable from inside the worker
        const modelUrl = new URL(`${import.meta.env.BASE_URL}${modelName}_web_model/model.json`, window.location.href).href;

        createDetector({
            modelUrl,
            order: requestedBackendOrder(),
            onProgress: (fractions) => {
                if (!cancelled) setLoading({ loading: true, progress: fractions }); // set loading fractions
            },
        }).then((det) => {
            if (cancelled) {
                det.dispose();
                return;
            }
            detector = det;
            console.info(`Detector ready: backend=${det.backend}, runs in ${det.mode}${det.device ? `, device: ${det.device}` : ""}`, det.failures.length ? `(skipped: ${det.failures.join("; ")})` : "");
            setBackendInfo(`${det.backend} · ${det.mode === "worker" ? "worker" : "main thread"}${det.device ? ` · ${det.device}` : ""}${det.failures.length ? ` · skipped: ${det.failures.join("; ")}` : ""}`);
            if (new URLSearchParams(window.location.search).has("debug")) window.__detector = det; // for console benchmarking
            setLoading({ loading: false, progress: 1 });
            setModel({
                net: det,
                inputShape: det.inputShape,
            }); // set model & input shape
        }).catch((err) => {
            if (cancelled) return;
            console.error("Failed to load model:", err);
            setLoading({ loading: false, progress: 0 });
            setLoadError(`Could not load the detection model (${err.message}). Please refresh the page.`);
        });

        return () => {
            cancelled = true;
            if (detector) detector.dispose();
        };
    }, []);

    return (
        <div className="App">
            {loading.loading && <Loader>Loading model... {(loading.progress * 100).toFixed(2)}%</Loader>}
            <div className="header">
                <h1>🦪 Live Oyster Detection App</h1>
                <p>
                    Live detection application on browser powered by <code>tensorflow.js</code>
                </p>
            </div>

            {loadError && <p style={{ color: "crimson" }}>{loadError}</p>}
            {backendInfo && new URLSearchParams(window.location.search).has("debug") && (
                <p style={{ fontSize: "0.8rem", opacity: 0.6 }}>Backend: {backendInfo}</p>
            )}

            <div className="content">

                {/* src is set by ButtonHandler. It must not follow annotatedSrc: that would reload the
                    already-annotated picture and trigger detection on it again. */}
                <img
                    ref={imageRef}
                    onLoad={() => {
                        detect(
                            imageRef.current,
                            model,
                            canvasRef.current,
                            (bakedDataUrl) => {
                                setAnnotatedSrc(bakedDataUrl);
                                setRecordedBlob(null); // a new picture: stop offering the old video
                                setLastInput("image");
                            }
                        );
                    }}
                />
                <video
                    autoPlay
                    muted
                    playsInline
                    ref={cameraRef}
                    onPlay={() => {
                        setLastInput("video");
                        detectVideo(cameraRef.current, model, canvasRef.current, setRecordedBlob, setRecordingState);
                    }}
                />
                <video
                    autoPlay
                    muted
                    playsInline
                    ref={videoRef}
                    onPlay={() => {
                        setLastInput("video");
                        detectVideo(videoRef.current, model, canvasRef.current, setRecordedBlob, setRecordingState);
                    }}
                />

                <canvas width={model.inputShape[1]} height={model.inputShape[2]} ref={canvasRef} />



            </div>

            <ButtonHandler imageRef={imageRef} cameraRef={cameraRef} videoRef={videoRef} />
            {recordingState === "recording" && (
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
                    <span style={{ color: "crimson" }}>●</span> Recording the annotated video. Close the webcam (or
                    let the video finish) to get the download.
                </p>
            )}
            {recordingState === "saving" && (
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>Preparing your video…</p>
            )}
            {recordingState === "unavailable" && (
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", opacity: 0.7 }}>
                    This browser can't record video here, so only single images can be downloaded.
                </p>
            )}
            <DownloadButton canvasRef={canvasRef} recordedBlob={recordedBlob} lastInput={lastInput} />
        </div>
    );
};

export default App;
