@echo off
rem Abre o PokeBot: uma janela com o painel e as 4 contas dentro. O servidor sobe junto.
rem Se houver uma versao nova compilada (PokeBot-novo.exe), ela entra no lugar antes de abrir.
if exist "%~dp0host\bin\PokeBot-novo.exe" move /y "%~dp0host\bin\PokeBot-novo.exe" "%~dp0host\bin\PokeBot.exe" >nul
start "" /max "%~dp0host\bin\PokeBot.exe"
