// app/firebase.js
export function initFirebase() {
  const firebaseConfig = {
    apiKey: "AIzaSyDpLxC0IHpKK5xaSobgHB9uLCGHCOnF1Ww",
    authDomain: "reech-darts-dev.firebaseapp.com",
    projectId: "reech-darts-dev",
    storageBucket: "reech-darts-dev.firebasestorage.app",
    messagingSenderId: "470859725756",
    appId: "1:470859725756:web:88cbe8cfd067fe0ab049b9",
  };

  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  const db = firebase.firestore();

  console.log("Firebase connected");
  return db;
}
