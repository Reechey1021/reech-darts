// app/profile.js

// Guest display name is stored locally only.
const GUEST_NAME_KEY = "guestDisplayName";

export function getGuestDisplayName() {
  return (localStorage.getItem(GUEST_NAME_KEY) || "").trim();
}

export function setGuestDisplayName(name) {
  const cleaned = (name || "").trim();
  localStorage.setItem(GUEST_NAME_KEY, cleaned);
  return cleaned;
}

export function clearGuestDisplayName() {
  localStorage.removeItem("guestDisplayName");
}

// Best-effort: Google displayName → guest display name → email prefix → fallback
export function getEffectiveDisplayName(user) {
  const googleName = (user?.displayName || "").trim();
  if (googleName) return googleName;

  const guest = getGuestDisplayName();
  if (guest) return guest;

  const email = (user?.email || "").trim();
  if (email && email.includes("@")) return email.split("@")[0];

  return user?.isAnonymous ? "Guest" : "Player";
}
