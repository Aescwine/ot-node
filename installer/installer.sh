#!/bin/bash

OS_VERSION=$(lsb_release -sr)
GRAPHDB_FILE=$(ls /root/graphdb*.zip)
GRAPHDB_DIR=$(echo $GRAPHDB_FILE | sed 's|-dist.zip||')
OTNODE_DIR="/root/ot-node"
N1=$'\n'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

clear

cd /root

echo -n "Updating Ubuntu package repository: "

OUTPUT=$(apt update 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error updating the Ubuntu repo."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Updating Ubuntu to latest version (may take a few minutes): "

OUTPUT=$(export DEBIAN_FRONTEND=noninteractive && apt upgrade -y 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo -n "There was an error updating Ubuntu to the latest version."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Installing default-jre: "

OUTPUT=$(apt install default-jre unzip jq -y 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error installing default-jre."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

while true; do
    read -p "Please select the database you would like to use: [1]GraphDB [2]Blazegraph [E]xit: " choice
    case "$choice" in
        [1gG]* ) echo -e "GraphDB selected. Proceeding with installation."; DATABASE=graphdb; break;;
        [2bB]* ) echo -e "Blazegraph selected. Proceeding with installation."; DATABASE=blazegraph; break;;
        [Ee]* ) echo "Installer stopped by user"; exit;;
        * ) echo "Please make a valid choice and try again.";;
    esac
done

if [[ $DATABASE = "graphdb" ]]; then
    
    echo -n "Checking that the GraphDB file is present in /root: "

    if [[ ! -f $GRAPHDB_FILE ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "The graphdb file needs to be downloaded to /root. Please create an account at https://www.ontotext.com/products/graphdb/graphdb-free/ and click the standalone version link in the email."
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Unzipping GraphDB: "
OUTPUT=$(unzip -o $GRAPHDB_FILE >/dev/null 2>&1)
OUTPUT=$(unzip -o $GRAPHDB_FILE 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error unzipping GraphDB."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Rename GraphDB directory: "
OUTPUT=$(mv $GRAPHDB_DIR graphdb-free 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error unzipping GraphDB."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

    echo -n "Copying graphdb service file: "

    OUTPUT=$(cp $OTNODE_DIR/installer/data/graphdb.service /lib/systemd/system/ 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error copying the graphdb service file."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    systemctl daemon-reload

    echo -n "Enable GraphDB service on boot: "

    OUTPUT=$(systemctl enable graphdb 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error enabling the GraphDB service."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Starting GraphDB: "

    OUTPUT=$(systemctl start graphdb 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error starting GraphDB."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Confirming GraphDB has started: "

    IS_RUNNING=$(systemctl show -p ActiveState --value graphdb)

    if [[ $IS_RUNNING == "active" ]]; then
        echo -e "${GREEN}SUCCESS${NC}"
    else
        echo -e "${RED}FAILED${NC}"
        echo "There was an error starting GraphDB."
        echo $OUTPUT
        exit 1
    fi
fi

if [[ $DATABASE = "blazegraph" ]]; then
    
    echo -n "Downloading Blazegraph: " 

    OUTPUT=$(wget https://github.com/blazegraph/database/releases/download/BLAZEGRAPH_2_1_6_RC/blazegraph.jar 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error downloading Blazegraph."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Copying blazegraph service file: "

    OUTPUT=$(cp $OTNODE_DIR/installer/data/blazegraph.service /lib/systemd/system/ 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error copying the blazegraph service file."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    systemctl daemon-reload

    echo -n "Enable Blazegraph service on boot: "

    OUTPUT=$(systemctl enable blazegraph 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error enabling Blazegraph."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Starting Blazegraph: "

    OUTPUT=$(systemctl start blazegraph 2>&1)

    if [[ $? -ne 0 ]]; then
        echo -e "${RED}FAILED${NC}"
        echo "There was an error starting Blazegraph."
        echo $OUTPUT
        exit 1
    else
        echo -e "${GREEN}SUCCESS${NC}"
    fi

    echo -n "Confirming Blazegraph has started: "

    IS_RUNNING=$(systemctl show -p ActiveState --value blazegraph)

    if [[ $IS_RUNNING == "active" ]]; then
        echo -e "${GREEN}SUCCESS${NC}"
    else
        echo -e "${RED}FAILED${NC}"
        echo "There was an error starting Blazegraph."
        echo $OUTPUT
        exit 1
    fi
fi

echo -n "Updating the Ubuntu repo: "

OUTPUT=$(apt update 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error updating the Ubuntu repo."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Installing nodejs: "

 OUTPUT=$(apt-get install nodejs -y 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error installing nodejs/npm."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Installing tcllib and mysql-server: "

OUTPUT=$(apt-get install tcllib mysql-server -y 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error installing tcllib and mysql-server."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Creating a local operational database: "

mysql -u root -e "CREATE DATABASE operationaldb /*\!40100 DEFAULT CHARACTER SET utf8 */;"
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error creating the database (Step 1 of 3)."
    echo $OUTPUT
    exit 1
fi

mysql -u root -e "update mysql.user set plugin = 'mysql_native_password' where User='root';"
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error updating mysql.user set plugin (Step 2 of 3)."
    echo $OUTPUT
    exit 1
fi

mysql -u root -e "flush privileges;"
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error flushing privileges (Step 3 of 3)."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Commenting out max_binlog_size: "

OUTPUT=$(sed -i 's|max_binlog_size|#max_binlog_size|' /etc/mysql/mysql.conf.d/mysqld.cnf 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error commenting out max_binlog_size."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Disabling binary logs: "

OUTPUT=$(echo "disable_log_bin" >> /etc/mysql/mysql.conf.d/mysqld.cnf)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error disabling binary logs."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Restarting mysql: "

OUTPUT=$(systemctl restart mysql 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error restarting mysql."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

# Change directory to ot-node
cd ot-node

echo -n "Executing npm install: "

OUTPUT=$(npm install 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error executing npm install."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Opening firewall ports 22,8900,9000: "

OUTPUT=$(ufw allow 22/tcp && ufw allow 8900 && ufw allow 9000 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error opening the firewall ports."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Enabling the firewall: "

OUTPUT=$(yes | ufw enable 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error enabling the firewall."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Adding NODE_ENV=testnet to .env: "

OUTPUT=$(echo "NODE_ENV=testnet" > .env)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error adding the env variable."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo "Creating default noderc config${N1}"

read -p "Enter the operational wallet address: " NODE_WALLET
echo "Node wallet: $NODE_WALLET"

read -p "Enter the private key: " NODE_PRIVATE_KEY
echo "Node private key: $NODE_PRIVATE_KEY"

cp $OTNODE_DIR/.origintrail_noderc_example $OTNODE_DIR/.origintrail_noderc

jq --arg newval "$NODE_WALLET" '.blockchain[].publicKey |= $newval' $OTNODE_DIR/.origintrail_noderc >> $OTNODE_DIR/origintrail_noderc_temp
mv $OTNODE_DIR/origintrail_noderc_temp $OTNODE_DIR/.origintrail_noderc

jq --arg newval "$NODE_PRIVATE_KEY" '.blockchain[].privateKey |= $newval' $OTNODE_DIR/.origintrail_noderc >> $OTNODE_DIR/origintrail_noderc_temp
mv $OTNODE_DIR/origintrail_noderc_temp $OTNODE_DIR/.origintrail_noderc

if [[ $DATABASE = "blazegraph" ]]; then
    jq '.graphDatabase |= {"implementation": "Blazegraph", "url": "http://localhost:9999/blazegraph"} + .' $OTNODE_DIR/.origintrail_noderc >> $OTNODE_DIR/origintrail_noderc_temp
    mv $OTNODE_DIR/origintrail_noderc_temp $OTNODE_DIR/.origintrail_noderc
fi

echo -n "Running DB migrations: "

OUTPUT=$(npx sequelize --config=./config/sequelizeConfig.js db:migrate 2>&1)
if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error running the db migrations."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Copying otnode service file: "

OUTPUT=$(cp $OTNODE_DIR/installer/data/otnode.service /lib/systemd/system/ 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error copying the otnode service file."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

systemctl daemon-reload

echo -n "Enable otnode service on boot: "

OUTPUT=$(systemctl enable otnode 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error enabling the otnode service."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Starting otnode: "

OUTPUT=$(systemctl start otnode 2>&1)

if [[ $? -ne 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    echo "There was an error starting the node."
    echo $OUTPUT
    exit 1
else
    echo -e "${GREEN}SUCCESS${NC}"
fi

echo -n "Confirming the node has started: "

IS_RUNNING=$(systemctl show -p ActiveState --value otnode)

if [[ $IS_RUNNING == "active" ]]; then
    echo -e "${GREEN}SUCCESS${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "There was an error starting the node."
    echo $OUTPUT
    exit 1
fi

echo -n "Logs will be displayed. Press ctrl+c to exit the logs. The node WILL stay running after you return to the command prompt."
echo ""
echo "If the logs do not show and the screen hangs, press ctrl+c to exit the installation and reboot your server."
echo ""
read -p "Press enter to continue..."

journalctl -u otnode --output cat -fn 100
