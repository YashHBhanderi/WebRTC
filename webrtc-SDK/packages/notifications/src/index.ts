/**
 * @spreewe/notifications — headless activity-feed service plus Web Components. Importing this entry
 * does NOT register custom elements; import "@spreewe/notifications/define" once for that (or define
 * the classes under your own tags).
 */
export * from "./service.js";
export * from "./types.js";
export { SpreeWeNotificationList, type NotificationSelectDetail } from "./components/notification-list.js";
export { SpreeWeNotificationBell, type NotificationPanelToggleDetail } from "./components/notification-bell.js";
export { notificationTitle, notificationPreview, actorName } from "./components/shared.js";
