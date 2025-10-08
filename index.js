// Impor library yang dibutuhkan
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");

// --- Inisialisasi ---
const app = express();
app.use(express.urlencoded({ extended: true })); // Agar bisa membaca data dari webhook Twilio

// Inisialisasi koneksi database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Diperlukan untuk koneksi ke Neon/Heroku
});

// Inisialisasi klien Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- Logika MQTT (Menerima Data dari Perangkat IoT) ---
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

mqttClient.on("connect", () => {
  console.log("Terhubung ke HiveMQ Broker!");
  // Subscribe ke topik dimana semua perangkat mengirim data
  mqttClient.subscribe("devices/+/data", (err) => {
    if (err) console.error("Gagal subscribe:", err);
  });
});

mqttClient.on("message", async (topic, message) => {
  try {
    const deviceId = topic.split("/")[1]; // Ekstrak deviceId dari topik
    const data = JSON.parse(message.toString()); // Ubah pesan jadi JSON

    console.log(`Menerima data dari ${deviceId}:`, data);

    // 1. Simpan data ke database
    await pool.query(
      "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
      [deviceId, data.temperature, data.humidity, data.gas_ppm]
    );

    // 2. Cek apakah melebihi ambang batas
    const deviceRes = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [deviceId]
    );
    if (deviceRes.rows.length === 0) return; // Perangkat tidak terdaftar

    const device = deviceRes.rows[0];
    let alertMessage = "";
    if (data.temperature > device.threshold_temp) {
      alertMessage = `PERINGATAN! Suhu di ${
        device.device_name || deviceId
      } mencapai ${data.temperature}°C.`;
    } else if (data.gas_ppm > device.threshold_gas) {
      alertMessage = `PERINGATAN! Kadar gas di ${
        device.device_name || deviceId
      } mencapai ${data.gas_ppm} PPM.`;
    }

    // 3. Jika ada peringatan, kirim WhatsApp
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

// --- Endpoint Webhook (Menerima Perintah dari WhatsApp) ---
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From; // Nomor pengirim (format: whatsapp:+62...)

  console.log(`Pesan masuk dari ${fromNumber}: ${incomingMsg}`);

  if (incomingMsg === "cek") {
    try {
      // 1. Cari perangkat milik pengguna ini
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

      // 2. Ambil data sensor terakhir dari perangkat itu
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
      const replyMsg = `Update Terakhir untuk Perangkat ${deviceId}:\n\n🌡️ Suhu: ${
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

  res.status(200).send(); // Balas ke Twilio bahwa pesan diterima
});

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
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
