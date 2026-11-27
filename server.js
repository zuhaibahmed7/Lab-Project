const fs = require("fs");
const path = require("path");

// Load .env if present (Node 20.12+ / 22 built-in)
const envPath = path.join(__dirname, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn("Could not load .env file:", err.message);
  }
}

const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const session = require("express-session");
const db = require("./db");

function getMailConfig() {
  const user = (process.env.MAIL_USER || "").trim();
  const pass = (process.env.MAIL_PASS || "").trim();
  const notifyTo = (process.env.ADMIN_EMAIL || user).trim();
  return { user, pass, notifyTo };
}

function createTransporter(user, pass) {
  return nodemailer.createTransport({
    service: "Gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

async function sendRegistrationEmails(alumnus, loginUrl) {
  const { user, pass, notifyTo } = getMailConfig();
  if (!user || !pass) {
    console.log(
      `[SMTP] Skipping registration emails for ${alumnus.email} (set MAIL_USER and MAIL_PASS in .env to enable SMTP)`
    );
    return;
  }

  const transporter = createTransporter(user, pass);

  // 1. Welcome email to the newly registered alumnus (includes login link)
  const welcomePromise = transporter.sendMail({
    from: `"AlumniConnect · Sukkur IBA" <${user}>`,
    to: alumnus.email,
    subject: "Welcome to the Alumni Community",
    text:
      `Hi ${alumnus.full_name},\n\n` +
      `Your registration was successful. You are now part of the AlumniConnect network.\n\n` +
      `You can sign in to view your profile and the alumni directory using your email (${alumnus.email}):\n` +
      `${loginUrl}\n\n` +
      `AlumniConnect — Sukkur IBA University`,
  });

  // 2. Notification email to the configured SMTP/admin email
  const adminNotifyPromise = notifyTo
    ? transporter.sendMail({
        from: `"AlumniConnect · Sukkur IBA" <${user}>`,
        to: notifyTo,
        subject: `New Alumni Registered: ${alumnus.full_name}`,
        text:
          `A new alumnus has registered on AlumniConnect:\n\n` +
          `Name: ${alumnus.full_name}\n` +
          `Email: ${alumnus.email}\n` +
          `Phone: ${alumnus.phone}\n` +
          `Student ID: ${alumnus.student_id}\n` +
          `Degree: ${alumnus.degree}\n` +
          `Department: ${alumnus.department}\n` +
          `Graduation Year: ${alumnus.graduation_year}\n` +
          `Designation: ${alumnus.current_job || "N/A"}\n` +
          `Organization: ${alumnus.company || "N/A"}\n` +
          `Location: ${alumnus.city}, ${alumnus.country}\n` +
          `Registered At: ${new Date().toISOString()}\n\n` +
          `Sign in to view directory: ${loginUrl}\n`,
      })
    : Promise.resolve();

  await Promise.all([welcomePromise, adminNotifyPromise]);
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false })); // read POST form data
app.use(express.static(path.join(__dirname, "public"))); // css & images
app.use(
  session({
    secret: process.env.SESSION_SECRET || "alumni-connect-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
  })
);
app.use((req, res, next) => {
  res.locals.currentUser = req.session.userId
    ? { id: req.session.userId, name: req.session.userName }
    : null;
  next();
});

// Forward async errors to the error handler
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const message = (res, status, title, text, type) =>
  res.status(status).render("message", { active: "register", title, text, type });
const requireLogin = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect("/login");
};

// Session: login
app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.render("login", { active: "login", error: null, email: "" });
});

app.post(
  "/login",
  wrap(async (req, res) => {
    const email = (req.body.email || "").trim();
    const password = req.body.password || "";
    if (!email || !password) {
      return res.status(400).render("login", {
        active: "login",
        error: "Enter both your email address and password.",
        email,
      });
    }
    const [rows] = await db.query(
      "SELECT id, full_name, password FROM alumni WHERE email = ?",
      [email]
    );
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password));
    if (!ok) {
      return res.status(401).render("login", {
        active: "login",
        error: "Email or password is incorrect.",
        email,
      });
    }
    req.session.userId = user.id;
    req.session.userName = user.full_name;
    res.redirect("/");
  })
);

// Session: logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Dashboard: statistics + latest 5 registrations
app.get(
  "/",
  requireLogin,
  wrap(async (req, res) => {
    const [[s]] = await db.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT department) AS depts,
              COUNT(DISTINCT city) AS cities,
              COALESCE(SUM(created_at >= NOW() - INTERVAL 7 DAY), 0) AS recent
       FROM alumni`
    );
    const [latest] = await db.query(
      "SELECT id, full_name, graduation_year, department FROM alumni ORDER BY id DESC LIMIT 5"
    );
    res.render("index", { active: "dashboard", s, latest });
  })
);

// Directory with search (?q=)
app.get(
  "/alumni",
  requireLogin,
  wrap(async (req, res) => {
    const q = (req.query.q || "").trim();
    const cols = "id, full_name, graduation_year, department, company, city";
    let rows;
    if (q) {
      const like = `%${q}%`;
      [rows] = await db.query(
        `SELECT ${cols} FROM alumni
         WHERE full_name LIKE ? OR department LIKE ? OR graduation_year LIKE ?
            OR company LIKE ? OR city LIKE ? ORDER BY id DESC`,
        [like, like, like, like, like]
      );
    } else {
      [rows] = await db.query(`SELECT ${cols} FROM alumni ORDER BY id DESC`);
    }
    res.render("alumni", { active: "alumni", q, rows });
  })
);

// Profile: /profile/:id, or current logged-in alumnus when no id is given
app.get(
  ["/profile", "/profile/:id"],
  requireLogin,
  wrap(async (req, res) => {
    const requestedId = parseInt(req.params.id, 10);
    const targetId = requestedId > 0 ? requestedId : req.session.userId;
    let [rows] = await db.query("SELECT * FROM alumni WHERE id = ?", [targetId]);
    if (!rows.length && !(requestedId > 0)) {
      [rows] = await db.query("SELECT * FROM alumni ORDER BY id DESC LIMIT 1");
    }
    res.render("profile", { active: "profile", person: rows[0] });
  })
);

// Registration
app.get("/register", (req, res) =>
  res.render("register", { active: "register" })
);

app.post(
  "/register",
  wrap(async (req, res) => {
    const f = {};
    for (const k of [
      "full_name",
      "email",
      "phone",
      "gender",
      "date_of_birth",
      "student_id",
      "degree",
      "department",
      "graduation_year",
      "current_job",
      "company",
      "city",
      "country",
      "address",
      "password",
    ]) {
      f[k] = (req.body[k] || "").toString().trim();
    }

    const required = [
      "full_name",
      "email",
      "phone",
      "gender",
      "date_of_birth",
      "student_id",
      "degree",
      "department",
      "graduation_year",
      "city",
      "country",
      "password",
    ];
    if (required.some((k) => f[k] === ""))
      return message(
        res,
        400,
        "Missing information",
        "Please fill all required fields.",
        "error"
      );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email))
      return message(
        res,
        400,
        "Invalid email",
        "Please enter a valid email address.",
        "error"
      );
    if (f.password.length < 6)
      return message(
        res,
        400,
        "Weak password",
        "Password must be at least 6 characters.",
        "error"
      );

    const [dup] = await db.query("SELECT id FROM alumni WHERE email = ?", [
      f.email,
    ]);
    if (dup.length)
      return message(
        res,
        409,
        "Already registered",
        "This email address is already registered.",
        "error"
      );

    const hash = await bcrypt.hash(f.password, 10); // never store plain text
    const [result] = await db.query(
      `INSERT INTO alumni (full_name, email, phone, gender, date_of_birth, student_id, degree,
        department, graduation_year, current_job, company, city, country, address, password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.full_name,
        f.email,
        f.phone,
        f.gender,
        f.date_of_birth,
        f.student_id,
        f.degree,
        f.department,
        Number(f.graduation_year),
        f.current_job,
        f.company,
        f.city,
        f.country,
        f.address,
        hash,
      ]
    );

    req.session.userId = result.insertId;
    req.session.userName = f.full_name;

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.get("host") || `localhost:${PORT}`;
    const loginUrl = `${protocol}://${host}/login`;

    sendRegistrationEmails(f, loginUrl)
      .then(() =>
        console.log(
          `Registration emails sent (alumnus: ${f.email}, admin: ${getMailConfig().notifyTo})`
        )
      )
      .catch((err) =>
        console.error(`Email failed for ${f.email}:`, err.message)
      );

    message(
      res,
      200,
      "Registration successful",
      `Welcome to the Alumni Community, ${f.full_name}!`,
      "success"
    );
  })
);

// 404 and error handlers
app.use((req, res) =>
  message(
    res,
    404,
    "Page not found",
    "The page you requested does not exist.",
    "error"
  )
);
app.use((err, req, res, next) => {
  console.error(err);
  message(
    res,
    500,
    "Server error",
    "Something went wrong. Please try again.",
    "error"
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Alumni system running at http://0.0.0.0:${PORT}`)
);
