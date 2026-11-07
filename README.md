
# AskWRI | Team 29 — Nexivra

**AWS Breaking Barriers 2026 Hackathon | World Resources Institute (WRI)**

AskWRI is an AI-powered research assistant designed to help researchers explore decades of WRI publications, find relevant information, and verify answers against original sources.

Built by Team 29 — Nexivra during the AWS Breaking Barriers 2026 Hackathon.

## Demo

## Demo

🎥 **[Watch the AskWRI Demo]([./AskWRI_Demo_Compatible.mp4](https://youtu.be/mkODQve-Fn4))**

The demo showcases the research interface, interactive 3D globe, AI-generated answers, and source citations.

**Note:** The application runs locally. A labeled sample-data mode is available when live AWS services are unavailable. Demo-mode responses are illustrative rather than live AI retrieval.

## The Problem

WRI has over 50 years of research and more than 1,300 public research publications.

Finding relevant information across these documents can be time-consuming, particularly for older research. WRI's existing research database covers publications from 2019 onward, leaving earlier work harder to discover.

Our goal was to explore how generative AI could help researchers spend less time searching and more time using existing research.

## Our Solution

AskWRI uses Retrieval-Augmented Generation (RAG) to answer questions using WRI's published research.

Rather than relying on general AI knowledge, the application retrieves relevant document passages and generates answers supported by source citations.

### Key Features

- **AI-powered research Q&A:** Ask questions across WRI publications.
- **Source citations:** View supporting passages and references to original documents.
- **Quote verification:** Check generated quotations against retrieved evidence.
- **Interactive 3D globe:** Explore geographic locations mentioned in research findings.
- **Follow-up questions:** Continue exploring a topic within the same research session.
- **Multilingual interface:** Support for several languages, with further translation validation needed.
- **Evidence safeguards:** Decline or remove claims when the available sources do not support them.
- **Demo mode:** Explore the interface without active AWS credentials.

## Tech Stack

| Component | Technology |
|---|---|
| Cloud platform | Amazon Web Services (AWS) |
| Document storage | Amazon S3 |
| AI platform | Amazon Bedrock |
| Retrieval | Amazon Bedrock Knowledge Bases |
| Language model | Claude Sonnet 5.5 |
| Backend | Python, FastAPI |
| Frontend | Vite, Three.js, JavaScript |
| Architecture | Retrieval-Augmented Generation (RAG) |
| Evaluation | Python, custom evaluation scripts |

## Architecture

The research workflow follows these steps:

1. WRI research documents are stored in Amazon S3.
2. Amazon Bedrock Knowledge Bases processes and retrieves relevant document passages.
3. The FastAPI backend receives user questions and communicates with AWS services.
4. Claude Sonnet 5.5 generates answers using retrieved research evidence.
5. The application checks supporting quotations and handles unsupported claims.
6. The frontend displays answers, citations, and geographic information on the interactive globe.

**Research Question → FastAPI → Bedrock Knowledge Base → Claude → Evidence Verification → User Interface**

The exact vector storage service used by the final Knowledge Base has not been independently verified.

## Evaluation Results

The repository includes an evaluation performed using a real Bedrock Knowledge Base with a subset of 10 WRI reports.

The evaluation used 17 questions, including 12 answerable and 5 unanswerable questions, with two runs per question.

| Metric | Before Tuning | After Tuning |
|---|---|---|
| Answerable questions incorrectly refused | 38% | 8% |
| Unanswerable questions correctly declined | 100% | 100% |
| Expected-source recall | 58% | 88% |
| Expected-source precision | 100% | 100% |
| Consistent outcomes across both runs | 16/17 | 17/17 |

Improvements included retrieving more passages, handling PDF formatting differences during quote verification, and retrying certain unsuccessful responses.

**Evaluation limitation:** These results reflect a small test set and a limited document subset. They should not be interpreted as overall accuracy across WRI's complete research collection.

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js and npm
- Git
- AWS credentials (only for live Bedrock functionality)

### 1. Clone the Repository

```bash
git clone YOUR_REPOSITORY_URL
cd Askwri_Team29_AWS
```

### 2. Configure Environment Variables

Copy the example configuration:

```bash
cp .env.example .env
```

On Windows Command Prompt:

```cmd
copy .env.example .env
```

For sample-data mode, confirm that `.env` includes:

```env
DEMO_MODE=true
```

Live AWS retrieval requires valid AWS credentials, Knowledge Base configuration, and any required Guardrails configuration.

### 3. Start the Backend

Open a terminal:

```bash
cd prototype/backend
python -m venv .venv
```

On Windows:

```cmd
.venv\Scripts\activate
```

On macOS/Linux:

```bash
source .venv/bin/activate
```

Install dependencies and start the API:

```bash
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload --port 8001
```

### 4. Start the Frontend

Open a second terminal:

```bash
cd prototype/frontend
npm ci
npm run dev
```

Open the local URL shown in your terminal, normally:

http://localhost:5173

### 5. Run Tests

Backend:

```bash
cd prototype/backend
python -m pytest
```

Frontend:

```bash
cd prototype/frontend
npm test
```

Evaluation scripts and additional security tests are available in the repository.

## Project Status

The interactive globe prototype supports local execution with AWS integration when valid credentials and services are configured.

The application is not currently publicly deployed.

The repository also contains an experimental multi-agent architecture involving AgentCore and specialized research workflows. These components are separate from the working globe prototype and should not be considered fully implemented.

## Challenges and Lessons Learned

One of our biggest technical challenges involved connecting AWS resources across different team accounts.

We encountered issues between the Knowledge Base and application backend, requiring us to rebuild, re-sync, and re-index research data.

Working through these issues highlighted the importance of coordinating cloud infrastructure, sharing configuration decisions, and testing integrations early.

The project also reinforced the importance of evidence-backed AI: generating an answer is only part of the challenge. Researchers need to understand where the information came from and verify it.

## Team

**Team 29 — Nexivra**

- Abdulraheem Saleem
- Ali Amir
- Apurva Tiwari
- Zion Nascimento
- Damaris Goumtsop

**AWS Solutions Architect Mentor:** Sam Grace

**Nonprofit Partner:** World Resources Institute (WRI)

Built during the AWS Breaking Barriers 2026 Hackathon.

## Acknowledgments

Thank you to the World Resources Institute team for sharing their research challenges and working with us throughout the event.

Special thanks to AWS Solutions Architect Sam Grace for his guidance and support during development and troubleshooting.

Thanks also to AWS and the Breaking Barriers organizers for bringing students, cloud professionals, and nonprofit organizations together to work on real-world challenges.

## Disclaimer

AskWRI is a hackathon research prototype, not an official WRI production application.

The project uses public research documents. Demo-mode responses are illustrative and clearly labeled. Live AI functionality requires properly configured AWS resources.
