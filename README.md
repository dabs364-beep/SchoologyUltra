# Schoology Pro Max

A locally running web application that connects to the Schoology API to provide an enhanced student portal experience.

## Features

- **OAuth Authentication**: Full OAuth 1.0a flow to connect with your Schoology account
- **Assignments Dashboard**: View all upcoming assignments across your courses
- **Custom Assignments**: Create your own assignments to track alongside Schoology ones
- **Assignment Completion**: Mark assignments as completed with strikethrough (saved in cookies)
- **Grades Page**: View all your grades by course
- **Grade Calculator**: Edit grades to see "what-if" scenarios and how they affect your overall grade
- **Persistent Storage**: All your customizations are saved in long-lasting cookies (1 year)

## Setup

### 1. Get Schoology API Credentials

1. Log into Schoology as an admin or request API access from your school
2. Go to **Tools** > **API** > **API Credentials**
3. Create new credentials or use existing ones
4. Note down your **Consumer Key** and **Consumer Secret**

### 2. Configure the Application

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your credentials:
   ```
   SCHOOLOGY_CONSUMER_KEY=your_consumer_key_here
   SCHOOLOGY_CONSUMER_SECRET=your_consumer_secret_here
   SCHOOLOGY_DOMAIN=app.schoology.com  # or your school's custom domain
   SESSION_SECRET=some_random_secret_string
   PORT=3000
   ```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Application

```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

### 5. Access the App

Open your browser and go to: `http://localhost:3000`

## Usage

### Connecting to Schoology
1. Click "Connect with Schoology" on the home page
2. You'll be redirected to Schoology to authorize the app
3. Once authorized, you'll be redirected back to the dashboard

### Assignments Page
- View all upcoming assignments from your courses
- Check the checkbox to mark an assignment as completed (adds strikethrough)
- Click "+ Add Custom" to create your own assignments
- Use the filter dropdown to view assignments by course
- Toggle "Hide Completed" to focus on incomplete tasks

### Grades Page
- Click on a course to expand and see all grades
- Edit any grade value to see how it would affect your overall grade
- Use the "What-If Calculator" to add hypothetical grades
- Click "Reset All Changes" to restore original grades
- Modified grades are highlighted in yellow

## Cookie Storage

The following data is stored in cookies (persists for 1 year):
- Completed assignments
- Custom assignments
- Modified grades for what-if scenarios

## API Endpoints Used

This application uses the following Schoology API endpoints:
- `GET /users/me` - Get current user info
- `GET /users/{id}/sections` - Get user's enrolled sections
- `GET /sections/{id}/assignments` - Get assignments for a section
- `GET /users/{id}/grades?section_id={id}` - Get user's grades
- `GET /sections/{id}/grading_categories` - Get grading categories

## Security Notes

- Your Schoology credentials are only stored in your local `.env` file
- Access tokens are stored in server-side sessions
- The app only runs locally on your machine
- Never share your API credentials or commit them to version control

## Deploying to Vercel

This app is optimized for Vercel deployment. Note that **Quiz Viewer features are disabled on Vercel** because Playwright (headless browser) is too large for serverless deployment.

### 1. Install Vercel CLI (optional)

```bash
npm i -g vercel
```

### 2. Set up Environment Variables

In your Vercel project settings, add these environment variables:

| Variable | Description |
|----------|-------------|
| `SCHOOLOGY_CONSUMER_KEY` | Your Schoology API consumer key |
| `SCHOOLOGY_CONSUMER_SECRET` | Your Schoology API consumer secret |
| `SCHOOLOGY_DOMAIN` | Your school's Schoology domain (e.g., `fuhsd.schoology.com`) |
| `SESSION_SECRET` | A random secret string for session encryption |
| `GEMINI_API_KEY` | (Optional) Google Gemini API key for AI features |

### 3. Deploy

Using Vercel CLI:
```bash
vercel
```

Or connect your GitHub repository to Vercel for automatic deployments.

### Vercel Limitations

- **Quiz Viewer**: Unavailable (requires Playwright which exceeds serverless size limits)
- **Sessions**: In-memory sessions don't persist between serverless invocations
- **Notifications/Schedule**: Stored in memory only, won't persist between requests

For full features including Quiz Viewer, run the app locally.

## Troubleshooting

### "Failed to initiate OAuth"
- Check that your consumer key and secret are correct in `.env`
- Ensure your API credentials have the necessary permissions

### "Failed to fetch user data"
- Your access token may have expired; try logging out and back in
- Check your Schoology API rate limits

### Grades not showing
- Make sure you're enrolled in courses with graded assignments
- Some grade information may be restricted by your school's settings

### Quiz Viewer not working on Vercel
- This is expected! Quiz Viewer requires Playwright which is too large for serverless
- Run the app locally for quiz features: `npm run dev`

## License

MIT License - Feel free to modify and use as needed!
