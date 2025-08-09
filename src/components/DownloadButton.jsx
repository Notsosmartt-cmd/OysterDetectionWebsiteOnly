const DownloadButton = ({ annotatedSrc, canvasRef, recordedBlob }) => {
    const handleDownload = () => {
        if (recordedBlob) {
            const videoUrl = URL.createObjectURL(recordedBlob);
            const link = document.createElement("a");
            link.href = videoUrl;
            link.download = "annotated_video.webm";
            link.click();
        } else {
            const link = document.createElement("a");
            link.download = "annotated_image.png";
            link.href = annotatedSrc || canvasRef.current.toDataURL("image/png");
            link.click();
        }
    };

    return (
        <button onClick={handleDownload} style={{ marginTop: "1rem" }}>
            📥 Download Annotated {recordedBlob ? "Video" : "Image"}
        </button>
    );
};

export default DownloadButton;
