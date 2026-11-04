
import { useState } from "react";
import "./App.css";

const API_URL = "http://localhost:3001";

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState("30");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [video, setVideo] = useState(null);
  const [clip, setClip] = useState(null);
  const [error, setError] = useState("");

  async function analyzeVideo(event) {
    event.preventDefault();

    setError("");
    setVideo(null);
    setClip(null);

    if (!url.trim()) {
      setError("Insira um link de vídeo.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/videos/info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Não foi possível analisar o vídeo."
        );
      }

      setVideo(data);
    } catch (err) {
      setError(err.message || "Erro de conexão com o servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function generateClip() {
    if (!video || !url.trim()) {
      setError("Analise um vídeo antes de gerar o clipe.");
      return;
    }

    setGenerating(true);
    setError("");
    setClip(null);

    try {
      const response = await fetch(`${API_URL}/api/clips/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url.trim(),
          duration: Number(duration),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Não foi possível gerar o clipe."
        );
      }

      setClip(data);
    } catch (err) {
      setError(err.message || "Erro ao gerar clipe.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div>
            <strong>ClipForge</strong>
            <span>AI STUDIO</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="navigation">
          <button
            className={page === "dashboard" ? "active" : ""}
            onClick={() => setPage("dashboard")}
          >
            <span>▦</span> Dashboard
          </button>

          <button
            className={page === "library" ? "active" : ""}
            onClick={() => setPage("library")}
          >
            <span>▤</span> Meus clipes
          </button>

          <button
            className={page === "live" ? "active" : ""}
            onClick={() => setPage("live")}
          >
            <span>◉</span> Live AI
          </button>

          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <span>⚙</span> Configurações
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="plan-card">
            <span>PLANO ATUAL</span>
            <strong>Local Developer</strong>
            <p>Processamento no seu computador.</p>
          </div>

          <div className="profile">
            <div className="avatar">CF</div>
            <div>
              <strong>Meu workspace</strong>
              <small>Ambiente local</small>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace / {page}
          </div>

          <div className="topbar-right">
            <span className="status-dot" />
            <span>Local Studio</span>
            <div className="top-avatar">CF</div>
          </div>
        </header>

        {page === "dashboard" && (
          <div className="content">
            <div className="hero">
              <div className="hero-copy">
                <div className="eyebrow">
                  ✦ AI-POWERED VIDEO CLIPPING
                </div>

                <h1>
                  Transforme vídeos em
                  <br />
                  <span>clipes incríveis.</span>
                </h1>

                <p>
                  Importe seus vídeos, prepare cortes para TikTok,
                  Reels e YouTube Shorts e acompanhe a evolução
                  do projeto.
                </p>

                <div className="hero-tags">
                  <span>
                    ✦ Inteligência artificial — em desenvolvimento
                  </span>
                  <span>⚡ FFmpeg local</span>
                </div>
              </div>

              <div className="hero-art">
                <div className="art-orbit orbit-one" />
                <div className="art-orbit orbit-two" />
                <div className="art-center">▶</div>
                <div className="art-float float-one">
                  ✂ Auto Clip
                </div>
                <div className="art-float float-two">
                  9:16
                </div>
              </div>
            </div>

            <div className="section-heading">
              <div>
                <h2>Criar novo projeto</h2>
                <p>Comece importando um vídeo para análise.</p>
              </div>

              <span className="section-badge">
                BETA LOCAL
              </span>
            </div>

            <form
              className="import-card"
              onSubmit={analyzeVideo}
            >
              <div className="import-title">
                <div className="import-icon">↗</div>

                <div>
                  <h3>Importar vídeo</h3>
                  <p>
                    Cole o link de um vídeo que você tem
                    permissão para usar.
                  </p>
                </div>
              </div>

              <label htmlFor="video-url">
                LINK DO VÍDEO
              </label>

              <div className="input-row">
                <input
                  id="video-url"
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setVideo(null);
                    setClip(null);
                    setError("");
                  }}
                  required
                  disabled={generating}
                />

                <button
                  type="submit"
                  disabled={loading || generating}
                >
                  {loading
                    ? "Analisando..."
                    : "Analisar vídeo →"}
                </button>
              </div>

              <div className="import-options">
                <div>
                  <label htmlFor="duration">
                    DURAÇÃO DESEJADA
                  </label>

                  <select
                    id="duration"
                    value={duration}
                    onChange={(event) => {
                      setDuration(event.target.value);
                      setClip(null);
                    }}
                    disabled={generating}
                  >
                    <option value="15">15 segundos</option>
                    <option value="30">30 segundos</option>
                    <option value="45">45 segundos</option>
                    <option value="60">60 segundos</option>
                    <option value="90">90 segundos</option>
                  </select>
                </div>

                <div>
                  <label>FORMATO</label>
                  <div className="option-static">
                    ▯ Vertical 9:16 (planejado)
                  </div>
                </div>
              </div>

              {error && (
                <div className="message error">
                  {error}
                </div>
              )}

              {video && (
                <div className="video-result">
                  {video.thumbnail && (
                    <img
                      src={video.thumbnail}
                      alt="Miniatura do vídeo"
                    />
                  )}

                  <div className="video-details">
                    <span className="result-label">
                      VÍDEO IDENTIFICADO
                    </span>

                    <h3>
                      {video.title || "Vídeo sem título"}
                    </h3>

                    <p>
                      {video.uploader || "Canal não informado"}
                    </p>

                    <small>
                      Duração:{" "}
                      {video.duration
                        ? `${Math.floor(video.duration / 60)} min ${Math.floor(video.duration % 60)} s`
                        : "Não informada"}
                    </small>

                    <div className="result-note">
                      Vídeo analisado com sucesso.
                      Agora você pode gerar seu primeiro clipe.
                    </div>

                    <button
                      type="button"
                      className="generate-button"
                      onClick={generateClip}
                      disabled={generating || loading}
                    >
                      {generating
                        ? "⏳ Gerando clipe..."
                        : "✂ Gerar clipe"}
                    </button>

                    {generating && (
                      <div className="processing-info">
                        <div className="processing-spinner" />

                        <div>
                          <strong>
                            Processando seu vídeo
                          </strong>
                          <p>
                            O servidor está baixando o vídeo
                            e gerando o MP4 com FFmpeg.
                            Isso pode levar alguns minutos.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {clip && (
                <div className="clip-result">
                  <div className="clip-success">
                    <div className="clip-success-icon">
                      ✓
                    </div>

                    <div>
                      <h3>
                        Seu clipe está pronto!
                      </h3>
                      <p>
                        Clipe de {clip.duration} segundos
                        gerado com sucesso.
                      </p>
                    </div>
                  </div>

                  <video
                    controls
                    src={clip.clipUrl}
                    className="clip-player"
                  />

                  <div className="clip-actions">
                    <a
                      href={clip.clipUrl}
                      download={clip.filename}
                      className="download-button"
                    >
                      ⬇ Baixar clipe MP4
                    </a>

                    <a
                      href={clip.clipUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="preview-button"
                    >
                      ↗ Abrir vídeo
                    </a>
                  </div>
                </div>
              )}
            </form>

            <div className="section-heading stats-heading">
              <div>
                <h2>Seu estúdio</h2>
                <p>
                  Funcionalidades e recursos do ClipForge AI.
                </p>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon purple">
                  ✂
                </div>

                <span>Recorte de vídeos</span>
                <strong>FFmpeg</strong>
                <small>
                  Geração de MP4 integrada
                </small>
              </div>

              <div className="stat-card">
                <div className="stat-icon blue">
                  ▣
                </div>

                <span>Legendas automáticas</span>
                <strong>Em breve</strong>
                <small>
                  Transcrição com IA local
                </small>
              </div>

              <div className="stat-card">
                <div className="stat-icon orange">
                  ◉
                </div>

                <span>Monitoramento de lives</span>
                <strong>Planejado</strong>
                <small>
                  OBS e transmissões autorizadas
                </small>
              </div>
            </div>

            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon">
                  ✦
                </div>

                <h3>
                  Momentos inteligentes
                </h3>

                <p>
                  Identificação automática de trechos
                  interessantes usando análise de áudio
                  e transcrição.
                </p>

                <span>
                  EM DESENVOLVIMENTO
                </span>
              </div>

              <div className="feature-card">
                <div className="feature-icon">
                  ▯
                </div>

                <h3>
                  Pronto para redes sociais
                </h3>

                <p>
                  Cortes verticais, legendas e exportação
                  para TikTok, Reels e Shorts.
                </p>

                <span>
                  EM DESENVOLVIMENTO
                </span>
              </div>
            </div>
          </div>
        )}

        {page === "library" && (
          <div className="content">
            <div className="page-header">
              <span className="eyebrow">
                SUA BIBLIOTECA
              </span>

              <h1>Meus clipes</h1>

              <p>
                Seus vídeos processados aparecerão aqui.
              </p>
            </div>

            <div className="empty-state">
              <div>▤</div>

              <h2>
                Biblioteca em desenvolvimento
              </h2>

              <p>
                Vamos conectar esta página à pasta
                storage/clips do back-end.
              </p>

              <button
                onClick={() => setPage("dashboard")}
              >
                Voltar ao dashboard
              </button>
            </div>
          </div>
        )}

        {page === "live" && (
          <div className="content">
            <div className="page-header">
              <span className="eyebrow">
                LIVE MONITORING
              </span>

              <h1>
                Live AI{" "}
                <span className="coming-soon">
                  EM BREVE
                </span>
              </h1>

              <p>
                Prepare a captura de momentos durante
                transmissões.
              </p>
            </div>

            <div className="live-grid">
              <div className="live-card">
                <div className="live-icon">
                  ◉
                </div>

                <h3>
                  Monitoramento via OBS
                </h3>

                <p>
                  Captura de lives locais com buffer
                  contínuo e geração de clipes durante
                  a transmissão.
                </p>

                <span>
                  Integração futura
                </span>
              </div>

              <div className="live-card">
                <div className="live-icon">
                  ↗
                </div>

                <h3>
                  Links de transmissões
                </h3>

                <p>
                  Monitoramento de transmissões que você
                  possui ou tem autorização para processar.
                </p>

                <span>
                  Integração futura
                </span>
              </div>
            </div>
          </div>
        )}

        {page === "settings" && (
          <div className="content">
            <div className="page-header">
              <span className="eyebrow">
                PREFERÊNCIAS
              </span>

              <h1>Configurações</h1>

              <p>
                Ambiente de desenvolvimento local.
              </p>
            </div>

            <div className="settings-card">
              <h3>
                ClipForge AI — Developer Preview
              </h3>

              <p>Front-end: React + Vite</p>
              <p>Back-end: Node.js + Express</p>
              <p>
                Processamento: Python + yt-dlp + FFmpeg
              </p>
              <p>
                IA e publicação automática:
                ainda não integradas.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
