import { createApp } from "vue";
import App from "./App.vue";
import { trackFocusModality } from "./dom.ts";
import "./style.css";

trackFocusModality();
createApp(App).mount("#app");
