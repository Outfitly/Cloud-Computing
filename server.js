const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const os = require('os');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, sendEmailVerification } = require('firebase/auth');
const { OAuth2Client } = require('google-auth-library');
const { sendPasswordResetEmail } = require('firebase/auth');
const app = express();
app.use(bodyParser.json());
app.use(cors());

const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: `${serviceAccount.project_id}.appspot.com`,
});


const firebaseConfig = {
    apiKey: "AIzaSyAy3d92UQt5HvtroBBuhX8JnLoTkecELtY", // Pastikan API key valid
    authDomain: `${serviceAccount.project_id}.firebaseapp.com`,
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Konfigurasi Google Cloud Storage
const storage = admin.storage().bucket();
const upload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${file.originalname}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // Maksimal 5MB
});

app.post('/signup', upload.single('profileImage'), async (req, res) => {
    const { email, password, name, birthdate } = req.body;
    const profileImage = req.file;

    try {
        const user = await admin.auth().createUser({
            email,
            password,
            displayName: name,
        });

        // Kirim email verifikasi
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        await sendEmailVerification(userCredential.user);

        let photoURL = null;
        if (profileImage) {
            const destination = `profile-images/${user.uid}/${profileImage.filename}`;
            await storage.upload(profileImage.path, { destination, metadata: { contentType: profileImage.mimetype } });
            photoURL = `https://storage.googleapis.com/${serviceAccount.project_id}.appspot.com/${destination}`;
        }

        const db = admin.firestore();
        await db.collection('users').doc(user.uid).set({
            name,
            email,
            birthdate,
            photoURL,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(201).json({ uid: user.uid, message: 'User created successfully', photoURL });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk verifikasi kode email
app.post('/verify-email', async (req, res) => {
    const { uid } = req.body;

    try {
        const userRecord = await admin.auth().getUser(uid);

        if (userRecord.emailVerified) {
            return res.status(200).json({ message: 'Email already verified' });
        }

        await admin.auth().updateUser(uid, { emailVerified: true });
        res.status(200).json({ message: 'Email verified successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/reset-password', async (req, res) => {
    const { email } = req.body;

    try {
        // Kirim email reset password
        await sendPasswordResetEmail(auth, email);

        res.status(200).json({ message: 'Password reset email sent successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});



// Endpoint untuk login menggunakan email dan password
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(user.uid).get();

        if (!userDoc.exists) {
            throw new Error('User data not found');
        }

        res.status(200).json({
            uid: user.uid,
            email: user.email,
            name: user.displayName || userDoc.data().name,
            photoURL: user.photoURL || userDoc.data().photoURL,
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk mengirim email reset password
app.post('/reset-password', async (req, res) => {
    const { email } = req.body;

    try {
        if (!email) {
            throw new Error('Email is required');
        }

        // Kirim email reset password
        await auth.sendPasswordResetEmail(email);
        res.status(200).json({ message: 'Password reset email sent successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk login menggunakan Google
app.post('/google-login', async (req, res) => {
    const { idToken } = req.body;
    const googleClientId = 'YOUR_GOOGLE_CLIENT_ID'; // Ganti dengan client ID Google Anda
    const oauth2Client = new OAuth2Client(googleClientId);

    try {
        const ticket = await oauth2Client.verifyIdToken({ idToken, audience: googleClientId });
        const payload = ticket.getPayload();
        const { sub, email, name, picture } = payload;

        let userRecord;
        try {
            userRecord = await admin.auth().getUser(sub);
        } catch {
            userRecord = await admin.auth().createUser({ uid: sub, email, displayName: name, photoURL: picture });
        }

        const db = admin.firestore();
        const userDoc = db.collection('users').doc(userRecord.uid);
        const userSnapshot = await userDoc.get();

        if (!userSnapshot.exists) {
            await userDoc.set({
                name,
                email,
                photoURL: picture,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        res.status(200).json({ uid: userRecord.uid, message: 'User logged in successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk mendapatkan profil pengguna
app.get('/profile/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        const userRecord = await admin.auth().getUser(uid);
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) throw new Error('User data not found');

        res.status(200).json({
            uid: userRecord.uid,
            email: userRecord.email,
            name: userRecord.displayName,
            photoURL: userRecord.photoURL,
            birthdate: userDoc.data().birthdate,
            createdAt: userDoc.data().createdAt.toDate(),
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk memperbarui profil pengguna
app.put('/profile/:uid', upload.single('profileImage'), async (req, res) => {
    const { uid } = req.params;
    const { name, birthdate } = req.body;
    const profileImage = req.file;

    try {
        const updates = { displayName: name };
        let photoURL = null;

        if (profileImage) {
            const destination = `profile-images/${uid}/${profileImage.filename}`;
            await storage.upload(profileImage.path, { destination, metadata: { contentType: profileImage.mimetype } });
            photoURL = `https://storage.googleapis.com/${serviceAccount.project_id}.appspot.com/${destination}`;
            updates.photoURL = photoURL;
        }

        await admin.auth().updateUser(uid, updates);
        const db = admin.firestore();
        await db.collection('users').doc(uid).update({ name, birthdate, photoURL });

        res.status(200).json({ uid, message: 'Profile updated successfully', photoURL });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk menghapus pengguna
app.delete('/profile/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        await admin.auth().deleteUser(uid);
        const db = admin.firestore();
        await db.collection('users').doc(uid).delete();

        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk memperbarui foto profil pengguna
app.put('/profile/:uid/photo', upload.single('profileImage'), async (req, res) => {
    const { uid } = req.params;
    const profileImage = req.file;

    try {
        if (!profileImage) {
            return res.status(400).json({ error: 'No photo provided' });
        }

        const destination = `profile-images/${uid}/${profileImage.filename}`;
        await storage.upload(profileImage.path, { destination, metadata: { contentType: profileImage.mimetype } });
        const photoURL = `https://storage.googleapis.com/${serviceAccount.project_id}.appspot.com/${destination}`;

        // Perbarui foto profil pengguna di Firebase Authentication
        await admin.auth().updateUser(uid, { photoURL });

        // Perbarui foto profil di Firestore
        const db = admin.firestore();
        await db.collection('users').doc(uid).update({ photoURL });

        res.status(200).json({ uid, message: 'Profile photo updated successfully', photoURL });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Endpoint untuk mengambil foto profil pengguna
app.get('/profile/:uid/photo', async (req, res) => {
    const { uid } = req.params;

    try {
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            throw new Error('User data not found');
        }

        const photoURL = userDoc.data().photoURL;
        if (!photoURL) {
            throw new Error('No profile photo available');
        }

        res.status(200).json({ photoURL });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.send('Welcome to the authentication service!');
});

// Menjalankan server
app.listen(8080, () => {
    console.log('Server running on port 8080');
});
