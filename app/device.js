// app/device.js

export function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).toString();
    localStorage.setItem("deviceId", id);
  }
  return id;
}

export function isTouchDevice() {
  return window.matchMedia("(pointer: coarse)").matches;
}
