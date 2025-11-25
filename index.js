// --- 1. IMPOR LIBRARY ---
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors");

// --- 2. INISIALISASI ---
const app = express();

// Middleware (Body Parser)
app.use(cors()); // Mengizinkan Flutter (domain lain)
app.use(express.json()); // Membaca JSON dari Flutter
app.use(express.urlencoded({ extended: true })); // Membaca data dari Webhook Twilio

// Koneksi Database (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Klien Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Klien MQTT (HiveMQ)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

// ========================================================
// --- 3. LOGIKA MQTT (PERANGKAT -> SERVER) ---
// ========================================================
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");
  // Subscribe ke topik data dari semua perangkat
  mqttClient.subscribe("devices/+/data", (err) => {
    if (err) console.error("Gagal subscribe:", err);
  });
});

// Fungsi ini berjalan setiap kali data sensor masuk
// [BAGIAN INI YANG HARUS DIGANTI DENGAN KODE DI BAWAH]
mqttClient.on("message", async (topic, message) => {
  try {
    const deviceId = topic.split("/")[1]; // Ambil ID dari topik

    // --- [PERBAIKAN PENTING DI SINI] ---
    // Parse data, menangani format Array [...] atau Objek {...}
    let rawData = JSON.parse(message.toString());
    let data;
    if (Array.isArray(rawData) && rawData.length > 0) {
      data = rawData[0]; // Ambil item pertama jika array
    } else if (typeof rawData === "object" && rawData !== null) {
      data = rawData; // Gunakan langsung jika objek
    } else {
      console.error(`⚠️ Format data dari ${deviceId} tidak dikenali.`);
      return;
    }

    // Validasi kelengkapan data (gunakan nama field yang sesuai dengan pengiriman alat)
    // Pastikan alat mengirim 'gas_ppm' atau 'amonia', sesuaikan pengecekan di sini
    if (
      !data ||
      data.temperature === undefined ||
      (data.gas_ppm === undefined && data.amonia === undefined)
    ) {
      console.error(`⚠️ Data dari ${deviceId} tidak lengkap.`);
      return;
    }
    // ----------------------------------

    // Normalisasi nama field gas (jika alat kirim 'amonia', kita pakai sebagai 'gas_ppm')
    const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;

    console.log(
      `📥 Menerima data dari ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
    );

    // 1. Simpan data ke database Neon
    await pool.query(
      "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
      [deviceId, data.temperature, data.humidity, gasValue]
    );

    // 2. Cek apakah perangkat terdaftar untuk notifikasi
    const deviceRes = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [deviceId]
    );
    if (deviceRes.rows.length === 0) return; // Perangkat tidak terdaftar, abaikan

    // 3. Cek ambang batas
    const device = deviceRes.rows[0];
    let alertMessage = "";
    if (data.temperature > device.threshold_temp) {
      alertMessage = `PERINGATAN! Suhu di ${
        device.device_name || deviceId
      } mencapai ${data.temperature}°C.`;
    } else if (gasValue > device.threshold_gas) {
      alertMessage = `PERINGATAN! Kadar gas di ${
        device.device_name || deviceId
      } mencapai ${gasValue} PPM.`;
    }

    // 4. Jika ada peringatan, kirim WhatsApp
    if (alertMessage) {
      const userRes = await pool.query(
        "SELECT whatsapp_number FROM users WHERE user_id = $1",
        [device.user_id]
      );
      if (userRes.rows.length > 0) {
        const userNumber = userRes.rows[0].whatsapp_number;
        await sendWhatsApp(userNumber, alertMessage);
      }
    }
  } catch (err) {
    console.error("Error memproses pesan MQTT:", err);
  }
});

// ========================================================
// --- 4. LOGIKA WEBHOOK (WHATSAPP -> SERVER) ---
// ========================================================
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From; // format: whatsapp:+62...

  console.log(`Pesan masuk dari ${fromNumber}: ${incomingMsg}`);

  if (incomingMsg === "cek") {
    try {
      // 1. Cari perangkat milik pengguna
      const deviceRes = await pool.query(
        "SELECT d.device_id FROM devices d JOIN users u ON d.user_id = u.user_id WHERE u.whatsapp_number = $1",
        [fromNumber.replace("whatsapp:", "")]
      );

      if (deviceRes.rows.length === 0) {
        await sendWhatsApp(
          fromNumber,
          "Nomor Anda belum terdaftar di perangkat manapun."
        );
        return res.status(200).send();
      }
      const deviceId = deviceRes.rows[0].device_id;

      // 2. Ambil data sensor terakhir
      const dataRes = await pool.query(
        "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [deviceId]
      );

      if (dataRes.rows.length === 0) {
        await sendWhatsApp(fromNumber, "Belum ada data sensor yang terekam.");
        return res.status(200).send();
      }
      const latestData = dataRes.rows[0];

      // 3. Format dan kirim balasan
      const replyMsg = `Update Terakhir (${deviceId}):\n\n🌡️ Suhu: ${
        latestData.temperature
      }°C\n💧 Lembap: ${latestData.humidity}%\n💨 Gas: ${
        latestData.gas_ppm
      } PPM\n🕒 Waktu: ${latestData.timestamp.toLocaleTimeString("id-ID")}`;
      await sendWhatsApp(fromNumber, replyMsg);
    } catch (err) {
      console.error('Error membalas "cek":', err);
      await sendWhatsApp(fromNumber, "Maaf, terjadi kesalahan di server.");
    }
  }

  res.status(200).send(); // Balas OK ke Twilio
});

// ========================================================
// --- 5. LOGIKA API (FLUTTER APP -> SERVER) ---
// ========================================================

// Tes koneksi (buka URL Render Anda di browser)
app.get("/", (req, res) => {
  res.send("Backend Smart Kandang (Twilio + Flutter) is RUNNING! 🚀");
});

// Endpoint untuk validasi perangkat
app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });
    const result = await pool.query(
      "SELECT device_id, device_name FROM devices WHERE device_id = $1",
      [id]
    );
    if (result.rows.length > 0) {
      res.status(200).json({ status: "success", device: result.rows[0] });
    } else {
      res.status(404).json({ status: "error", message: "Device not found" });
    }
  } catch (err) {
    console.error("Error di /api/check-device:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Endpoint untuk mengambil data sensor
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, gas_ppm FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows); // Kirim [List] ke Flutter
  } catch (err) {
    console.error("Error di /api/sensor-data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Endpoint untuk mengambil jadwal pakan
app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]); // Kirim { "times": [...] }
    } else {
      res.json({ times: [] }); // Belum ada jadwal
    }
  } catch (err) {
    console.error("Error di /api/schedule (GET):", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Endpoint untuk menyimpan/update jadwal pakan
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body; // { "times": ["08:00", ...] }

    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // 1. Simpan/Update ke Database (UPSERT)
    const query = `
      INSERT INTO schedules (device_id, times) VALUES ($1, $2)
      ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
    `;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // 2. Kirim perintah Real-time ke Alat Pakan via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    console.log(`📤 Perintah dikirim ke ${commandTopic}`);

    res.json({ status: "success" });
  } catch (err) {
    console.error("Error di /api/schedule (POST):", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================================================
// --- 6. FUNGSI BANTUAN & SERVER START ---
// ========================================================

// Fungsi bantuan untuk mengirim WhatsApp
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });
    console.log(`Pesan terkirim ke ${to}`);
  } catch (err) {
    console.error(`Gagal mengirim pesan ke ${to}:`, err.message);
  }
}

// Jalankan server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));
