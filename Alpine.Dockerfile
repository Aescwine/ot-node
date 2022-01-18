FROM mhart/alpine-node:14

#Install Papertrail
RUN wget https://github.com/papertrail/remote_syslog2/releases/download/v0.20/remote_syslog_linux_amd64.tar.gz
RUN tar xzf ./remote_syslog_linux_amd64.tar.gz && cd remote_syslog && cp ./remote_syslog /usr/local/bin
ADD config/papertrail.yml /etc/log_files.yml

#Install nodemon & forever
RUN npm install forever -g

WORKDIR /ot-node

COPY . .

#Install nppm
RUN npm install
RUN npm ci --only=production
RUN npm install --save form-data
RUN npm install pm2 -g

CMD [ "pm2-runtime", "index.js"]