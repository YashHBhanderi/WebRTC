/**
 * @spreewe/files — headless files service plus Web Components. Importing this entry does NOT
 * register custom elements; import "@spreewe/files/define" once for that (or define the classes
 * under your own tags).
 */
export * from "./service.js";
export * from "./types.js";
export { SpreeWeFileList } from "./components/file-list.js";
export { SpreeWeSharedMedia, type SharedMediaTab } from "./components/shared-media.js";
export { displayName, type FileSelectDetail } from "./components/shared.js";
