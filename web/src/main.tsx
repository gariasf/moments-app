import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Without these, a file dropped outside a drop target replaces Moments with it.
window.addEventListener("dragover", (event) => {
	if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files"))
		return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => {
	if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
