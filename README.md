# 🛡️ Integrated Moderation & Support System

Hello! 👋
This is one of my public portfolio projects, developed with the goal of making Discord communities safer, more organized and easier to manage.
The system was designed to improve both the moderator workflow and the overall member experience.

---

## 🔨 1. Smart Moderation System

This bot goes beyond simply executing punishments.
Before any moderation action is applied, the user is notified via Direct Message (DM), ensuring transparency and clearer communication.

- **Commands:** `/mod kick`, `/mod ban`, `/mod timeout`
- **Key Feature:** Built-in hierarchy validation prevents moderators from accidentally punishing users with higher permissions.

---

## 📝 2. Warning System (Persistent Warns)

Moderation history should never be lost.
Using **MongoDB integration**, every warning is permanently stored, allowing the moderation team to make informed decisions based on real user behavior.

- **Commands:** `/warn add`, `/warn list`
- **Key Feature:** Clean and structured warning history designed for fast readability and efficient moderation.

---

## 🎫 3. Ticket Support System

Support requests should not create server clutter.
This system allows members to open private support channels instantly through an interactive button.

- **How it works:** When a user clicks the ticket button, a dedicated private channel is automatically created.
- **Key Feature:** The system prevents users from opening multiple tickets simultaneously, keeping the server structured and organized.

---

## 🛠️ Technologies Used

This project was built using modern tools and architecture practices:

- **Node.js & Discord.js** — Core framework for event-driven bot development
- **MongoDB** — Persistent data storage for moderation records
- **Dotenv** — Secure environment configuration and token protection
- **Modular Architecture** — Commands and logic separated into structured modules for scalability and maintainability

---

## 🚀 How to Run This Project

1. **Clone the repository**
   `git clone https://github.com/hearts4skypurr/Moderation-Bot-EN.git`

2. **Install dependencies**
   `npm install`

3. **Configure environment variables**
   Rename `.env.example` to `.env` and insert your credentials.

4. **Start the bot**
   `node index.js`

---

## ⚠️ Terms of Use & Copyright

This project was developed by **Lynn** exclusively for portfolio and technical demonstration purposes.

- **Personal Use:** You are free to study the code and use it as a learning reference.
- **Commercial Restriction:** Selling, redistributing or repackaging this code (fully or partially) as a paid product is not allowed without prior permission.
- **Plagiarism:** Copying this repository for submission in third-party portfolios or applications is strictly prohibited.

By using this code, you agree to maintain proper credit to the original author.

---

Developed with ☕ and 💻 by **Lynn**

---
