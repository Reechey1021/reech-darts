console.log("Darts Online loaded");

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCG8yBJ5JeUlDQmWi27nrPLmezwu7IdrEM",
    authDomain: "reech-darts.firebaseapp.com",
    projectId: "reech-darts",
  };
  
  // Initialize Firebase
  firebase.initializeApp(firebaseConfig);
  
  // Initialize Firestore
  const db = firebase.firestore();
  
  console.log("Firebase connected");
  
  const gameRef = db.collection("games").doc("test-game");

  // Create ONLY if missing (so you don't overwrite every refresh)
  gameRef.get().then((doc) => {
    if (!doc.exists) {
      gameRef.set({
        message: "Hello from Firebase",
        lastUpdated: new Date()
      });
    }
  });
  
  // Listen for real-time updates
  gameRef.onSnapshot((doc) => {
    const data = doc.data();
    document.getElementById("status").innerText = data?.message || "No data yet";
  });
  