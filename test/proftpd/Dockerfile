FROM alpine:3.20
RUN apk add --no-cache proftpd proftpd-mod_tls openssl \
 && adduser -D -h /home/tester tester \
 && echo 'tester:pass' | chpasswd \
 && mkdir -p /etc/ssl/private /run/proftpd \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj '/CN=localhost/O=iRemote test' \
      -keyout /etc/ssl/private/ftp.pem -out /etc/ssl/private/ftp.pem \
 && chmod 600 /etc/ssl/private/ftp.pem
COPY proftpd.conf /etc/proftpd/proftpd.conf
EXPOSE 21 30000-30009
CMD ["proftpd", "--nodaemon"]
