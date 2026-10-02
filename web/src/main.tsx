import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

// kitab-lens is dark-only (a phone camera app), so there is no theme
// detection or toggle here — unlike the sibling kitab-translator webui.
//
// StrictMode is deliberately skipped: its dev-only double-invoke of effects
// would start/stop the camera stream and open/close SSE job connections
// twice on every mount, which is confusing to debug and buys nothing here
// (there's no unintentional side-effect-in-render bug to catch).
ReactDOM.createRoot(document.getElementById("root")!).render(<App />)
