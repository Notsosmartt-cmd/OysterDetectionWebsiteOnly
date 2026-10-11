// lastInput: "image" (an uploaded picture), "video" (uploaded clip or webcam) or null (nothing opened yet)
const DownloadButton = ({ canvasRef, recordedBlob, lastInput }) => {
    // the picture currently shown on the canvas (video + boxes), as a PNG
    const downloadImage = () => {
        const link = document.createElement("a");
        link.download = "annotated_image.png";
        link.href = canvasRef.current.toDataURL("image/png");
        link.click();
    };

    // the finished recording (available once the video has ended / the webcam was closed)
    const downloadVideo = () => {
        const videoUrl = URL.createObjectURL(recordedBlob);
        const link = document.createElement("a");
        link.href = videoUrl;
        const ext = recordedBlob.type.includes("mp4") ? "mp4" : "webm";
        link.download = `annotated_video.${ext}`;
        link.click();
    };

    return (
        <div style={{ marginTop: "1rem" }}>
            {recordedBlob && <button onClick={downloadVideo}>📥 Download Annotated Video</button>}
            {lastInput === "image" && <button onClick={downloadImage}>📥 Download Annotated Image</button>}
            {/* for a video / webcam session this saves the frame that is on screen, not an uploaded picture */}
            {lastInput === "video" && <button onClick={downloadImage}>📥 Save Current Frame as Image</button>}
        </div>
    );
};

export default DownloadButton;
