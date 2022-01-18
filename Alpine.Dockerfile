#base image
FROM alpine:latest

MAINTAINER OriginTrail
LABEL maintainer="OriginTrail"
ENV NODE_ENV=testnet

#Install git, nodejs,python
RUN apk update
RUN apk add curl
RUN apk add wget npm
RUN apk add nodejs-current
RUN apk add make python3 


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


FROM mysql
#Mysql intialization
RUN /etc/init.d/mysql start && mysql -u root -pmysql  -e "CREATE DATABASE operationaldb /*\!40100 DEFAULT CHARACTER SET utf8 */; SET PASSWORD FOR root@localhost = PASSWORD(''); FLUSH PRIVILEGES;" && npx sequelize --config=./config/sequelizeConfig.js db:migrate

