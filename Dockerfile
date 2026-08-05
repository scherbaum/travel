FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY user-spots.json /usr/share/nginx/html/user-spots.json
COPY images/ /usr/share/nginx/html/images/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5000
