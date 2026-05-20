// ============================================================================
// Blizzard OS — Firebase configuration
// ============================================================================
// 1. Create a Firebase project at https://console.firebase.google.com/
// 2. Add a Web app to the project; copy the firebaseConfig object.
// 3. In the Firebase console:
//      - Build → Authentication → Sign-in method → enable "Email/Password"
//      - Build → Realtime Database → Create database → Start in test mode
// 4. Paste the values below and reload index.html.
// ----------------------------------------------------------------------------
// The OS will show a setup screen until this is populated.

export const firebaseConfig = {
  apiKey: "AIzaSyC4_Mrsm2pRbm7XZrUjD5zFru9dqSTK0UA",
  authDomain: "blizzard-402f4.firebaseapp.com",
  databaseURL: "https://blizzard-402f4-default-rtdb.firebaseio.com",
  projectId: "blizzard-402f4",
  storageBucket: "blizzard-402f4.firebasestorage.app",
  messagingSenderId: "650010556572",
  appId: "1:650010556572:web:c7873ab83a2195d3e25559",
  measurementId: "G-KB2G13FDNW"
};

export function isFirebaseConfigured() {
  return !!(firebaseConfig.apiKey && firebaseConfig.databaseURL && firebaseConfig.projectId);
}
