// app/firebase.js

export function initFirebase() {
  const firebaseConfig = {
    apiKey: "AIzaSyCG8yBJ5JeUlDQmWi27nrPLmezwu7IdrEM",
    authDomain: "reech-darts.firebaseapp.com",
    projectId: "reech-darts",
  };

  // Firebase is loaded globally via compat SDK <script> tags in index.html
  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  console.log("Firebase connected");
  return db;
}
