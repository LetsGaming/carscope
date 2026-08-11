import { createRouter, createWebHistory } from "vue-router";
import WorkspaceView from "./views/WorkspaceView.vue";
import VehicleView from "./views/VehicleView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "workspace", component: WorkspaceView },
    { path: "/fahrzeug/:id", name: "vehicle", component: VehicleView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
