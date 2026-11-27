const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const session = require("express-session");
const db = require("./db");

// SMTP transporter (Gmail app password)
const transporter = nodemailer.createTransport({
  service: "Gmail",
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.MAIL_USER || "", // the email you used to create app password
    pass: process.env.MAIL_PASS || "", // your generated app password
  },
});

function sendWelcomeEmail(to, fullName) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    console.log(`[AI Studio] Skipping welcome email to ${to} (MAIL_USER/MAIL_PASS not configured)`);
    return Promise.resolve();
  }
  return transporter.sendMail({
    from: process.env.MAIL_USER || "",
    to,
    subject: "Welcome to the Alumni Community",
    text:
      `Hi ${fullName},\n\n` +
      `Your registration was successful. You are now part of the alumni network.\n` +
      `You can view your profile and the alumni directory on the site.\n\n` +
      `AlumniConnect — Sukkur IBA University`,
  });
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false })); // read POST form data
app.use(express.static(path.join(__dirname, "public"))); // css
app.use(session({
  secret: process.env.SESSION_SECRET || "alumni-connect-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
}));
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
  if (req.session.userId) return res.redirect("/alumni");
  res.render("login", { active: "login" });
});

app.post("/login", wrap(async (req, res) => {
  const email = (req.body.email || "").trim();
  const password = req.body.password || "";
  if (!email || !password)
    return message(res, 400, "Missing information", "Enter your email and password.", "error");
  const [rows] = await db.query(
    "SELECT id, full_name, password FROM alumni WHERE email = ?", [email]);
  const user = rows[0];
  const ok = user && await bcrypt.compare(password, user.password);
  if (!ok)
    return message(res, 401, "Login failed", "Email or password is incorrect.", "error");
  req.session.userId = user.id;
  req.session.userName = user.full_name;
  res.redirect("/alumni");
}));

// Session: logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Dashboard: statistics + latest 5 registrations
app.get("/", requireLogin, wrap(async (req, res) => {
  const [[s]] = await db.query(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT department) AS depts,
            COUNT(DISTINCT city) AS cities,
            COALESCE(SUM(created_at >= NOW() - INTERVAL 7 DAY), 0) AS recent
     FROM alumni`);
  const [latest] = await db.query(
    "SELECT id, full_name, graduation_year, department FROM alumni ORDER BY id DESC LIMIT 5");
  res.render("index", { active: "dashboard", s, latest });
}));

// Directory with search (?q=)
app.get("/alumni", requireLogin, wrap(async (req, res) => {
  const q = (req.query.q || "").trim();
  const cols = "id, full_name, graduation_year, department, company, city";
  let rows;
  if (q) {
    const like = `%${q}%`;
    [rows] = await db.query(
      `SELECT ${cols} FROM alumni
       WHERE full_name LIKE ? OR department LIKE ? OR graduation_year LIKE ?
          OR company LIKE ? OR city LIKE ? ORDER BY id DESC`,
      [like, like, like, like, like]);
  } else {
    [rows] = await db.query(`SELECT ${cols} FROM alumni ORDER BY id DESC`);
  }
  res.render("alumni", { active: "alumni", q, rows });
}));

// Profile: /profile/:id, or latest alumnus when no id is given
app.get(["/profile", "/profile/:id"], requireLogin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = id > 0
    ? await db.query("SELECT * FROM alumni WHERE id = ?", [id])
    : await db.query("SELECT * FROM alumni ORDER BY id DESC LIMIT 1");
  res.render("profile", { active: "profile", person: rows[0] });
}));

// Registration
app.get("/register", (req, res) => res.render("register", { active: "register" }));

app.post("/register", wrap(async (req, res) => {
  const f = {};
  for (const k of ["full_name","email","phone","gender","date_of_birth","student_id",
    "degree","department","graduation_year","current_job","company","city","country",
    "address","password"]) f[k] = (req.body[k] || "").toString().trim();

  const required = ["full_name","email","phone","gender","date_of_birth","student_id",
    "degree","department","graduation_year","city","country","password"];
  if (required.some((k) => f[k] === ""))
    return message(res, 400, "Missing information", "Please fill all required fields.", "error");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email))
    return message(res, 400, "Invalid email", "Please enter a valid email address.", "error");
  if (f.password.length < 6)
    return message(res, 400, "Weak password", "Password must be at least 6 characters.", "error");

  const [dup] = await db.query("SELECT id FROM alumni WHERE email = ?", [f.email]);
  if (dup.length)
    return message(res, 409, "Already registered", "This email address is already registered.", "error");

  const hash = await bcrypt.hash(f.password, 10); // never store plain text
  const [result] = await db.query(
    `INSERT INTO alumni (full_name, email, phone, gender, date_of_birth, student_id, degree,
      department, graduation_year, current_job, company, city, country, address, password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.full_name, f.email, f.phone, f.gender, f.date_of_birth, f.student_id, f.degree,
     f.department, Number(f.graduation_year), f.current_job, f.company, f.city, f.country,
     f.address, hash]);

  req.session.userId = result.insertId;
  req.session.userName = f.full_name;

  sendWelcomeEmail(f.email, f.full_name)
    .then(() => console.log(`Welcome email sent to ${f.email}`))
    .catch((err) => console.error(`Email failed for ${f.email}:`, err.message));

  message(res, 200, "Registration successful", `Welcome to the Alumni Community, ${f.full_name}!`, "success");
}));

// 404 and error handlers
app.use((req, res) => message(res, 404, "Page not found", "The page you requested does not exist.", "error"));
app.use((err, req, res, next) => {
  console.error(err);
  message(res, 500, "Server error", "Something went wrong. Is MySQL running?", "error");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Alumni system running at http://0.0.0.0:${PORT}`));
