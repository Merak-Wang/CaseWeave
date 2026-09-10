@echo off
call "%~dp0setup.cmd" start %*
exit /b %errorlevel%
