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

// Create the game if it doesn't exist
gameRef.set(
  {
    message: "Hello from Reech Darts",
    lastUpdated: new Date()
  },
  { merge: true }
);

gameRef.onSnapshot((doc) => {
    const data = doc.data();
    console.log("Game updated:", data);
  
    document.getElementById("status").innerText =
      data?.message || "No data yet";
  });
  