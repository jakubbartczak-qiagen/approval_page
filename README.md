# QIAlearn My Teams Trainings Approvals

## Structure
- `backend/` - Express API and Docebo integration
- `frontend/` - Static UI for iframe embedding

## Local run

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm start
```

### Frontend
Open `frontend/index.html` with a local static server, or serve it from GitHub Pages/Netlify/Vercel.

## Important
- Do not commit `.env`.
- Set `FRONTEND_ORIGIN` to the deployed frontend URL.
- The backend uses cookie sessions and is prepared for iframe usage.