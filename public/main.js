const form = document.getElementById("downloadForm");
const logBox = document.getElementById("log");
const fileTree = document.getElementById("fileTree");



/* ✅ ADD THIS FUNCTION */
function appendLog(text) {
  if (!text || !text.trim()) return;

  logBox.textContent += text + "\n";
  logBox.scrollTop = logBox.scrollHeight; // auto scroll
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  logBox.textContent = "";
  fileTree.innerHTML = "";

  const data = new URLSearchParams(new FormData(form));

  // 🔥 FIX #1 — AWAIT THE FETCH
  const response = await fetch("/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: data
  });

  // 🔥 FIX #2 — ENSURE STREAM EXISTS
  if (!response.body) {
    appendLog("❌ No response stream received");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      appendLog(line);
      handleFileTree(line);
    }
  }

  appendLog("DOWNLOAD COMPLETE");
});
