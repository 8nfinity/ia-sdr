@echo off
REM Sem acentos e sem chcp de proposito: qualquer coisa fora do ASCII pode
REM quebrar a leitura do arquivo dependendo da configuracao do Windows.
cd /d "%~dp0"
title Publicar IA SDR no GitHub
set LOG=%~dp0publicar.log

echo ============================================ > "%LOG%"
echo Log de publicacao - %DATE% %TIME% >> "%LOG%"
echo ============================================ >> "%LOG%"

echo.
echo   ============================================
echo     PUBLICAR O IA SDR NO GITHUB
echo   ============================================
echo.
echo   (tudo o que acontecer fica salvo em publicar.log)
echo.

REM ---------- 1. o git existe? ----------
echo [1] procurando o git... >> "%LOG%"
where git >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   PROBLEMA: o Git nao esta instalado ou nao esta no PATH.
  echo.
  echo   Baixe em https://git-scm.com/download/win
  echo   Instale, FECHE esta janela e clique aqui de novo.
  echo.
  goto :fim
)
echo   [ok] git encontrado
git --version >> "%LOG%" 2>&1

REM ---------- 2. identidade ----------
echo [2] identidade do commit >> "%LOG%"
git config --global user.email > nul 2>&1 || git config --global user.email "Moysousajr@gmail.com"
git config --global user.name > nul 2>&1 || git config --global user.name "Moises Sousa"
echo   [ok] identidade configurada

REM ---------- 3. repositorio local ----------
echo [3] repositorio local >> "%LOG%"
if not exist ".git" (
  git init >> "%LOG%" 2>&1
  git branch -M main >> "%LOG%" 2>&1
  echo   [ok] repositorio criado
) else (
  echo   [ok] repositorio ja existia
)

echo [4] adicionando arquivos >> "%LOG%"
git add . >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   PROBLEMA ao adicionar os arquivos. Veja o publicar.log
  goto :fim
)

REM ---------- 4. TRAVA: o .env nao pode subir ----------
echo [5] conferindo se o .env ficou de fora >> "%LOG%"
git diff --cached --name-only > "%TEMP%\iasdr_staged.txt" 2>&1
findstr /B /E /C:".env" "%TEMP%\iasdr_staged.txt" > nul
if not errorlevel 1 (
  echo.
  echo   PAREI POR SEGURANCA
  echo   O arquivo .env entrou no commit - ele tem suas chaves da
  echo   Anthropic e da Twilio.
  echo.
  echo   Rode:   git rm --cached .env
  echo   E confira se o .gitignore tem a linha:  .env
  echo.
  goto :fim
)
echo   [ok] .env fora do commit - suas chaves estao seguras

REM ---------- 5. commit ----------
echo [6] commit >> "%LOG%"
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "IA SDR: prospeccao com IA, discador paralelo e painel multiusuario" >> "%LOG%" 2>&1
  echo   [ok] commit criado
) else (
  echo   [ok] nada novo para commitar
)

REM ---------- 6. GitHub ----------
echo [7] github cli >> "%LOG%"
where gh > nul 2>&1
if errorlevel 1 (
  echo.
  echo   O GitHub CLI nao esta instalado. Faca assim:
  echo   1. crie um repositorio vazio em github.com/new  ^(nome: ia-sdr, PRIVADO^)
  echo   2. rode aqui, trocando SEU_USUARIO:
  echo.
  echo      git remote add origin https://github.com/SEU_USUARIO/ia-sdr.git
  echo      git push -u origin main
  echo.
  goto :fim
)

gh auth status >> "%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo   Voce ainda nao entrou na sua conta do GitHub.
  echo   Escolha: GitHub.com  ^>  HTTPS  ^>  confirmar pelo navegador
  echo.
  gh auth login
  gh auth status > nul 2>&1
  if errorlevel 1 (
    echo   O login nao foi concluido. Rode o arquivo de novo.
    goto :fim
  )
)
echo   [ok] logado no GitHub

echo [8] enviando >> "%LOG%"
git remote get-url origin > nul 2>&1
if errorlevel 1 (
  echo   Criando o repositorio privado e enviando...
  gh repo create ia-sdr --private --source=. --push >> "%LOG%" 2>&1
) else (
  echo   Enviando as alteracoes...
  git push -u origin main >> "%LOG%" 2>&1
)
if errorlevel 1 (
  echo.
  echo   O envio falhou. As ultimas linhas do log:
  echo.
  powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 12"
  goto :fim
)

echo.
echo   ============================================
echo     PRONTO - codigo publicado
echo   ============================================
gh repo view --json url -q .url 2>nul
echo.
echo   Agora no Northflank: Create Service ^> Combined service,
echo   escolha este repositorio, build por Dockerfile, porta 3000,
echo   e volume em /app/data
echo.

:fim
echo.
echo   ------------------------------------------------
echo   Se algo deu errado, abra o arquivo publicar.log
echo   (na mesma pasta) e me mande o conteudo.
echo   ------------------------------------------------
echo.
pause
